import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

// DATA REFRESH ON VERCEL — Phase 2 of the migration.
//
// Strategy: run the EXISTING app/scripts/fetch-data.mjs byte-for-byte
// unchanged (it is pure Node — builtins only, no git, no deps) inside a
// /tmp sandbox: mirror the live private/data files from the GitHub
// contents API into the sandbox, spawn the script exactly as GitHub
// Actions does, then compare what it wrote against what came in. All
// 48 mapped pipeline rules are preserved by construction, because the
// code that implements them is identical.
//
// MODES (query ?mode= overrides env REFRESH_MODE, default shadow):
//   shadow — run + diff + verdict. Writes NOTHING back. The
//     side-by-side verification leg.
//   live — run + diff + verdict, then WRITE changed outputs back to
//     the repo via per-file sha compare-and-swap: a conflict means the
//     GitHub leg (still alive until Phase 3 lands) committed fresher
//     data mid-run, so the remaining writes ABORT — newer data always
//     wins, the next tick re-derives. Write order honors the
//     write-through rule: ema-anchor-overrides.json commits before any
//     schedule derived from it; an overrides failure skips the
//     schedule. After a successful write set, the dashboard deploy is
//     triggered (workflow_dispatch on deploy-code.yml — push-triggered
//     CI is GitHub's one remaining job).
//   Cutover = set Vercel env REFRESH_MODE=live (+ redeploy) so the
//   2-hourly cron flips to live, then delete GitHub's refresh schedule
//   TOGETHER with Phase 3's sender port (the same workflow hosts the
//   general sender — never orphan it).
//
// Auth: same shared secret as the EMA sender, or the cron bearer.

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const REPO = "YOUR-GITHUB-ORG/YOUR-DATA-REPO";
const DATA_DIR_REPO = "app/private/data";
// Durable parity record: one compact verdict per shadow run, appended
// via the contents API. Runtime logs rotate; the cutover decision
// reads THIS.
const VERDICTS_REPO_PATH = "app/private/data/refresh-shadow-verdicts.json";
// Row-array files whose MEMBERSHIP legitimately drifts between two
// fetch moments (live completions, the future-only boundary moving):
// judged on the intersection of keyed rows.
const KEYED_FILES: Record<string, string[]> = {
  "ema-prompt-schedule.json": ["pid", "wave", "key"],
  "due-reminders.json": ["pid", "alertId", "scheduledAt", "kind"],
  "send-candidates.json": ["pid", "alertId", "scheduledAt", "kind"],
};
const CHILD_TIMEOUT_MS = 700_000;

async function ghJson(pathname: string, token: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${pathname}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${pathname}`);
  return res.json();
}
async function ghRaw(pathname: string, token: string): Promise<Buffer> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${pathname}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw" },
    signal: AbortSignal.timeout(120_000), cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub raw ${res.status} for ${pathname}`);
  return Buffer.from(await res.arrayBuffer());
}
const sha1 = (b: Buffer) => crypto.createHash("sha1").update(b).digest("hex");
// Byte-exact write of what the pipeline produced, guarded by sha CAS.
async function ghPutRawFile(pathname: string, token: string, content: Buffer, sha: string | null, message: string): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { message, content: content.toString("base64") };
    if (sha) body.sha = sha;
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${pathname}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    return res.ok;
  } catch { return false; }
}

async function ghPutJsonFile(pathname: string, token: string, data: unknown, sha: string | null, message: string): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      message, content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64"),
    };
    if (sha) body.sha = sha;
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${pathname}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(25_000),
    });
    return res.ok;
  } catch { return false; }
}
// Repo Actions variables are the instantly-flippable control plane:
// SENDER_LEG ('github'|'vercel') decides which system sends, and
// SEND_LIVE stays the study-wide kill switch. Read fresh every
// invocation; fail SAFE (dry) when unreadable.
async function ghVar(name: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/variables/${name}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    if (!res.ok) return null;
    return ((await res.json()) as { value: string }).value ?? null;
  } catch { return null; }
}

async function ghGetShaAndJson(pathname: string, token: string): Promise<{ sha: string; data: unknown } | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${pathname}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(20_000), cache: "no-store",
    });
    if (!res.ok) return null;
    const b = await res.json() as { sha: string; content: string };
    return { sha: b.sha, data: JSON.parse(Buffer.from(b.content, "base64").toString()) };
  } catch { return null; }
}

// Semantic equality for the diff gate: the sandbox's parseCSV patch
// legitimately drops empty-string fields, so byte-compare fails while
// meaning is identical. Normalize both sides (recursively drop ""/null
// values and empty objects) and deep-compare. Anything that differs
// AFTER normalization is a real behavioral divergence.
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === "" || val === null || val === undefined) continue;
      // Run-stamps legitimately differ between legs (proven the sole
      // participants.json divergence in gate run 10).
      if (k === "fetchedAt") continue;
      const n = normalize(val);
      if (n && typeof n === "object" && !Array.isArray(n) && Object.keys(n).length === 0) continue;
      out[k] = n;
    }
    return out;
  }
  return v;
}
function semanticallyEqual(a: Buffer, b: Buffer): boolean | null {
  try {
    return JSON.stringify(normalize(JSON.parse(a.toString()))) ===
           JSON.stringify(normalize(JSON.parse(b.toString())));
  } catch { return null; }
}
// Names the exact paths that differ after normalization, so a
// semanticMatch=false is a finding, not a mystery.
function deepDiff(a: unknown, b: unknown, p: string, out: string[], cap: number): void {
  if (out.length >= cap) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${p}: array length ${a.length} → ${b.length}`); return; }
    for (let i = 0; i < a.length && out.length < cap; i++) deepDiff(a[i], b[i], `${p}[${i}]`, out, cap);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      if (out.length >= cap) return;
      deepDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${p}.${k}`, out, cap);
    }
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${p}: ${String(JSON.stringify(a)).slice(0, 80)} → ${String(JSON.stringify(b)).slice(0, 80)}`);
  }
}
function sampleDivergences(a: Buffer, b: Buffer): string[] {
  try {
    const out: string[] = [];
    deepDiff(normalize(JSON.parse(a.toString())), normalize(JSON.parse(b.toString())), "$", out, 40);
    return out;
  } catch { return ["<unparseable>"]; }
}

// Live-completion signature: between two fetches minutes apart,
// participants finish surveys — completion codes advance monotonically
// (0/1 → 1/2) and the completed cycle's survey link is dropped. A
// divergence consisting ONLY of these is study data in motion, never
// code divergence (a code bug cannot express itself solely as monotone
// completion advances).
function isCompletionDrift(lines: string[]): boolean {
  return lines.length > 0 && lines.every(l =>
    /\.complete: (0|1) → (1|2)$/.test(l) ||
    /\.surveyLink: ".+" → undefined$/.test(l));
}

// The prompt schedule's row SET responds to live REDCap data (a
// participant completing surveys prunes their upcoming rows), so two
// fetches minutes apart legitimately disagree on membership. Code
// equivalence is judged on the INTERSECTION: every row present in both
// must match exactly; membership drift is recorded, not failed.
function keyedRowParity(aBuf: Buffer, bBuf: Buffer, keyFields: string[]): { verdict: string | boolean; added: number; removed: number; sharedDiffs: string[] } {
  try {
    const key = (r: Record<string, unknown>) => keyFields.map(f => String(r[f])).join("|");
    const A = new Map((JSON.parse(aBuf.toString()) as Record<string, unknown>[]).map(r => [key(r), r]));
    const B = new Map((JSON.parse(bBuf.toString()) as Record<string, unknown>[]).map(r => [key(r), r]));
    const sharedDiffs: string[] = [];
    let shared = 0;
    for (const [k, ra] of A) {
      const rb = B.get(k);
      if (!rb) continue;
      shared++;
      if (JSON.stringify(normalize(ra)) !== JSON.stringify(normalize(rb))) {
        const out: string[] = [];
        deepDiff(normalize(ra), normalize(rb), `$[${k}]`, out, 5);
        sharedDiffs.push(...out);
      }
    }
    const added = [...B.keys()].filter(k => !A.has(k)).length;
    const removed = [...A.keys()].filter(k => !B.has(k)).length;
    if (sharedDiffs.length > 0) {
      if (isCompletionDrift(sharedDiffs)) return { verdict: "completion-drift", added, removed, sharedDiffs: sharedDiffs.slice(0, 10) };
      return { verdict: false, added, removed, sharedDiffs: sharedDiffs.slice(0, 20) };
    }
    return { verdict: added || removed ? "row-churn" : true, added, removed, sharedDiffs: [] };
  } catch { return { verdict: "<unparseable>", added: 0, removed: 0, sharedDiffs: [] }; }
}

function topLevelCount(buf: Buffer): number | null {
  try {
    const d = JSON.parse(buf.toString());
    if (Array.isArray(d)) return d.length;
    if (d && typeof d === "object") {
      const o = d as Record<string, unknown>;
      if (Array.isArray(o.participants)) return (o.participants as unknown[]).length;
      if (Array.isArray(o.reminders)) return (o.reminders as unknown[]).length;
      return Object.keys(o).length;
    }
    return null;
  } catch { return null; }
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }

async function run(req: NextRequest) {
  const secret = process.env.SWEEP_SECRET || "";
  const ghToken = process.env.GITHUB_DATA_TOKEN || "";
  const given = req.headers.get("x-sweep-secret") || req.nextUrl.searchParams.get("secret") || "";
  const bearerOk = req.headers.get("authorization") === `Bearer ${secret}`;
  if (!secret || (given !== secret && !bearerOk)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const mode = req.nextUrl.searchParams.get("mode") || process.env.REFRESH_MODE || "shadow";
  if (mode !== "shadow" && mode !== "live") {
    return NextResponse.json({ error: "mode must be shadow or live" }, { status: 400 });
  }
  if (!ghToken) return NextResponse.json({ error: "GITHUB_DATA_TOKEN missing" }, { status: 503 });
  // REDCap nightly downtime gate (00:40–07:00 ET), same rule the GitHub
  // pipeline enforces at run time. Live runs skip cleanly; shadow runs
  // may proceed (read-only, and useful parity data).
  if (mode === "live") {
    const [h, m] = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).split(":").map(Number);
    const mins = (h === 24 ? 0 : h) * 60 + m;
    if (mins >= 40 && mins < 7 * 60) {
      console.log("refresh-live: skipped — REDCap downtime window (00:40–07:00 ET)");
      return NextResponse.json({ mode, skipped: "redcap-downtime-gate" });
    }
  }
  try {
    return await pipelineRun(ghToken, mode);
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`refresh-shadow FAILED: ${msg}`);
    return NextResponse.json({ error: msg.slice(0, 400) }, { status: 500 });
  }
}

async function pipelineRun(ghToken: string, mode: string) {
  const started = Date.now();
  const ws = path.join("/tmp", `refresh-${started}`);
  const wsScripts = path.join(ws, "scripts");
  const wsData = path.join(ws, "private", "data");
  await fs.mkdir(wsScripts, { recursive: true });
  await fs.mkdir(wsData, { recursive: true });

  // The script itself ships in this function's bundle — with ONE
  // sandbox-only memory patch: parseCSV originally stores a property
  // for EVERY export column on EVERY row, and REDCap flat exports
  // carry a column for every field in the project (~thousands, nearly
  // all empty per event). That made ~4,000 rows weigh >3GB and OOM'd
  // three shadow runs. Skipping empty cells keeps reads identical for
  // all `row.field || fallback` access (undefined vs "") and shrinks
  // rows ~50x. The diff gate proves output-equality against GitHub's
  // unpatched leg before this ever lands in the script proper.
  const ANCHOR = 'for (let j = 0; j < headers.length; j++) r[headers[j]] = vals[j] ?? "";';
  // Empty cells are dropped EXCEPT `_complete` fields: those are
  // enumerated downstream (the per-visit forms dict records 0 = "not
  // started"), and diff run 9 proved they are the ONLY output-visible
  // consumers of empty cells. Keeping them restores byte-identical
  // outputs; dropping the rest still eliminates the multi-GB blowup.
  const PATCH = 'for (let j = 0; j < headers.length; j++) { const v = vals[j] ?? ""; if (v !== "" || headers[j].endsWith("_complete")) r[headers[j]] = v; }';
  const scriptSrc = (await fs.readFile(path.join(process.cwd(), "scripts", "fetch-data.mjs"), "utf-8"));
  if (!scriptSrc.includes(ANCHOR)) throw new Error("memory-patch anchor not found in fetch-data.mjs — refusing to run unpatched");
  await fs.writeFile(path.join(wsScripts, "fetch-data.mjs"), scriptSrc.replace(ANCHOR, PATCH));

  const mem = (label: string) => {
    const m = process.memoryUsage();
    console.log(`refresh-shadow MEM [${label}]: rss=${Math.round(m.rss / 1e6)}MB heap=${Math.round(m.heapUsed / 1e6)}MB`);
  };
  mem("start");
  // Ground truth on what memory this container ACTUALLY has (config
  // claims are not trusted after two silent OOM kills).
  let limitMB = 0;
  for (const p of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const v = (await fs.readFile(p, "utf-8")).trim();
      if (v && v !== "max") { limitMB = Math.round(Number(v) / 1e6); break; }
    } catch { /* next path */ }
  }
  console.log(`refresh-shadow: container memory limit = ${limitMB || "unknown"}MB`);
  // Mirror the LIVE data directory (not the bundle — the bundle can be
  // hours old) so the run starts from exactly what GitHub's leg would.
  console.log("refresh-shadow: mirroring live data dir");
  const listing = (await ghJson(DATA_DIR_REPO, ghToken)) as Array<{ name: string; type: string; sha: string }>;
  const before = new Map<string, { hash: string; bytes: number; count: number | null; buf: Buffer; ghSha: string }>();
  await Promise.all(listing.filter(f => f.type === "file" && f.name.endsWith(".json") && f.name !== "refresh-shadow-verdicts.json").map(async f => {
    const buf = await ghRaw(`${DATA_DIR_REPO}/${f.name}`, ghToken);
    await fs.writeFile(path.join(wsData, f.name), buf);
    // Counts only for small files at mirror time — parsing the 9MB
    // participants.json here (13 files in parallel) spikes the heap for
    // a purely cosmetic report field.
    before.set(f.name, { hash: sha1(buf), bytes: buf.length, count: buf.length < 2_000_000 ? topLevelCount(buf) : null, buf, ghSha: f.sha });
  }));
  mem("post-mirror");
  console.log(`refresh-shadow: mirrored ${before.size} files, spawning pipeline (node=${process.execPath})`);

  // Run the pipeline exactly as refresh-data.yml does (same entrypoint,
  // same env names; heap capped under the function's memory).
  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH || "",
    REDCAP_API_URL: process.env.REDCAP_API_URL || "",
    REDCAP_API_TOKEN: process.env.REDCAP_API_TOKEN || "",
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
    GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || "",
  };
  // Child heap sized from the MEASURED container limit, leaving ~700MB
  // for the parent, buffers, and non-heap child memory. (V8's own
  // auto-size picked ~1.1GB and starved; an over-promise invites the
  // cgroup OOM killer — this threads between the two.)
  // cgroup files are unreadable in this sandbox (limitMB=0), so the
  // default assumes the project's fluid PERFORMANCE tier (4GB): proven
  // applied when a 1.9GB child died without taking the instance down.
  const childHeapMB = limitMB ? Math.max(1200, limitMB - 700) : 3100;
  console.log(`refresh-shadow: child max-old-space-size=${childHeapMB}MB`);
  const child = spawn(process.execPath, [`--max-old-space-size=${childHeapMB}`, "scripts/fetch-data.mjs"], {
    cwd: ws, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  const memTimer = setInterval(() => mem("child-running"), 15_000);
  let out = "", err = "";
  child.stdout.on("data", (d: Buffer) => { out = (out + d.toString()).slice(-6000); });
  child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-6000); });
  const exitCode: number | null = await new Promise(resolve => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(-1); }, CHILD_TIMEOUT_MS);
    // Without this handler a spawn failure (ENOENT etc.) is an
    // unhandled 'error' event and kills the whole function.
    child.on("error", e => { clearTimeout(t); err += `spawn error: ${e.message}`; resolve(-2); });
    child.on("close", code => { clearTimeout(t); resolve(code); });
  });
  clearInterval(memTimer);
  mem("child-exited");
  console.log(`refresh-shadow: pipeline exited ${exitCode} after ${Math.round((Date.now() - started) / 1000)}s`);

  // Diff: what the identical code produced from the identical inputs.
  const changed: Array<Record<string, unknown>> = [];
  const unchanged: string[] = [];
  const afterBufs = new Map<string, Buffer>();
  const produced = await fs.readdir(wsData);
  for (const name of produced.filter(n => n.endsWith(".json")).sort()) {
    const buf = await fs.readFile(path.join(wsData, name));
    const prev = before.get(name);
    if (prev && prev.hash === sha1(buf)) { unchanged.push(name); continue; }
    afterBufs.set(name, buf);
    changed.push({
      file: name, new: !prev,
      beforeBytes: prev?.bytes ?? 0, afterBytes: buf.length,
      beforeCount: prev?.count ?? null, afterCount: topLevelCount(buf),
      // true = only empty-string/formatting differences (the sandbox
      // patch's known signature); false = REAL divergence; null =
      // unparseable. last-fetch.json always differs (fresh timestamps).
      ...(name === "last-fetch.json"
        ? { semanticMatch: "timestamp-churn" }
        : KEYED_FILES[name] && prev
          ? (() => { const k = keyedRowParity(prev.buf, buf, KEYED_FILES[name]); return { semanticMatch: k.verdict, rowChurn: { added: k.added, removed: k.removed }, ...(k.sharedDiffs.length ? { divergences: k.sharedDiffs } : {}) }; })()
          : (() => {
              const m = prev ? semanticallyEqual(prev.buf, buf) : null;
              if (m !== false || !prev) return { semanticMatch: m };
              const divs = sampleDivergences(prev.buf, buf);
              // Conclusive only when the sample is complete (below the
              // deepDiff cap); a capped sample cannot prove drift.
              if (divs.length < 40 && isCompletionDrift(divs)) return { semanticMatch: "completion-drift", divergences: divs.slice(0, 10) };
              return { semanticMatch: false, divergences: divs };
            })()),
    });
  }
  const report = {
    mode, exitCode, durationMs: Date.now() - started,
    containerMemMB: limitMB, childHeapMB,
    inputFiles: before.size, changed, unchanged,
    stdoutTail: out.slice(-2500), stderrTail: err.slice(-2500),
    errors: [] as string[],
  };
  console.log(`refresh-shadow: exit=${exitCode} ${Math.round(report.durationMs / 1000)}s changed=${changed.map(c => c.file).join(",")}`);

  // Append the verdict to the durable parity record (sha-retry, keeps
  // the last 100). A meta write — shadow mode still writes no pipeline
  // data.
  const verdict = {
    at: new Date().toISOString(), mode, exitCode, durationMs: report.durationMs,
    unchanged: unchanged.length,
    changed: changed.map(c => ({
      file: c.file, semanticMatch: c.semanticMatch ?? null,
      ...(c.rowChurn ? { rowChurn: c.rowChurn } : {}),
      // Attribution lives IN the record: false and drift verdicts name their paths.
      ...((c.semanticMatch === false || c.semanticMatch === "completion-drift") && Array.isArray(c.divergences)
        ? { divergences: (c.divergences as string[]).slice(0, 5) } : {}),
    })),
    parity: exitCode === 0 && changed.every(c =>
      c.semanticMatch === true || c.semanticMatch === "timestamp-churn"
      || c.semanticMatch === "row-churn" || c.semanticMatch === "completion-drift"),
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const cur = await ghGetShaAndJson(VERDICTS_REPO_PATH, ghToken);
    const list = (cur && Array.isArray(cur.data) ? cur.data as unknown[] : []).slice(-99);
    const ok = await ghPutJsonFile(VERDICTS_REPO_PATH, ghToken, [...list, verdict], cur?.sha ?? null,
      `refresh-shadow verdict [${verdict.at}] parity=${verdict.parity}`);
    if (ok) break;
    if (attempt === 2) report.errors.push("verdict record write failed");
  }

  // LIVE MODE write-back: changed outputs land in the repo byte-exact,
  // each guarded by sha CAS. A single conflict aborts the rest — the
  // GitHub leg committed fresher data mid-run, and newer data always
  // wins; the next tick re-derives from it. Ledgers are never written
  // (they belong to the senders). ema-anchor-overrides goes FIRST (the
  // write-through rule: overrides commit before any schedule derived
  // from them).
  const written: string[] = [];
  let writeAborted: string | null = null;
  let deployTriggered = false;
  if (mode === "live" && exitCode === 0 && afterBufs.size > 0) {
    const LEDGERS = new Set(["sent-log.json", "ema-sent-log.json"]);
    const order = ["ema-anchor-overrides.json", ...[...afterBufs.keys()].filter(n => n !== "ema-anchor-overrides.json").sort()];
    for (const name of order) {
      const buf = afterBufs.get(name);
      if (!buf || LEDGERS.has(name)) continue;
      const ok = await ghPutRawFile(`${DATA_DIR_REPO}/${name}`, ghToken, buf, before.get(name)?.ghSha ?? null,
        `vercel-refresh: ${name} [${new Date().toISOString()}]`);
      if (!ok) { writeAborted = name; report.errors.push(`write conflict/failure at ${name} — remaining writes aborted (newer data wins)`); break; }
      written.push(name);
    }
    console.log(`refresh-live: wrote=${written.join(",") || "none"} aborted=${writeAborted || "no"}`);
  }

  // SEND STAGE (live mode only, same order as the GitHub pipeline:
  // fetch → send → commit → deploy). The sender script runs UNCHANGED
  // in the same sandbox against the fresh files the fetch just wrote.
  // Which leg actually transmits is decided by the SENDER_LEG repo
  // variable, read fresh every run — 'vercel' here means live; anything
  // else (or unreadable) means DRY, so two legs can never both send.
  let sendStage: Record<string, unknown> = { ran: false };
  if (mode === "live" && exitCode === 0 && !writeAborted) {
    const elapsed = Date.now() - started;
    if (elapsed > 560_000) {
      sendStage = { ran: false, skipped: "time budget — the 18h catch-up horizon covers the gap until the next tick" };
    } else {
      const leg = (await ghVar("SENDER_LEG", ghToken)) || "github";
      const sendLive = (await ghVar("SEND_LIVE", ghToken)) === "true";
      const dryRun = !(leg === "vercel" && sendLive);
      await fs.mkdir(path.join(ws, "src", "lib"), { recursive: true });
      await fs.copyFile(path.join(process.cwd(), "scripts", "send-due-messages.mjs"), path.join(wsScripts, "send-due-messages.mjs"));
      await fs.copyFile(path.join(process.cwd(), "src", "lib", "timeline.ts"), path.join(ws, "src", "lib", "timeline.ts"));
      await fs.cp(path.join(process.cwd(), "node_modules", "nodemailer"), path.join(ws, "node_modules", "nodemailer"), { recursive: true });
      const ledgerBefore = await fs.readFile(path.join(wsData, "sent-log.json"), "utf-8").catch(() => "[]");
      const sChild = spawn(process.execPath, ["scripts/send-due-messages.mjs"], {
        cwd: ws, stdio: ["ignore", "pipe", "pipe"],
        env: {
          NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH || "",
          DRY_RUN: dryRun ? "true" : "false",
          GMAIL_USER: process.env.GMAIL_USER || "", GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || "",
          QUO_API_KEY: process.env.QUO_API_KEY || "", QUO_FROM_NUMBER: process.env.QUO_FROM_NUMBER || "",
          REDCAP_API_URL: process.env.REDCAP_API_URL || "", REDCAP_API_TOKEN: process.env.REDCAP_API_TOKEN || "",
        },
      });
      let sOut = "", sErr = "";
      sChild.stdout.on("data", (d: Buffer) => { sOut = (sOut + d.toString()).slice(-8000); });
      sChild.stderr.on("data", (d: Buffer) => { sErr = (sErr + d.toString()).slice(-4000); });
      const sExit: number | null = await new Promise(resolve => {
        const t = setTimeout(() => { sChild.kill("SIGKILL"); resolve(-1); }, Math.min(240_000, 760_000 - (Date.now() - started)));
        sChild.on("error", e => { clearTimeout(t); sErr += `spawn error: ${e.message}`; resolve(-2); });
        sChild.on("close", code => { clearTimeout(t); resolve(code); });
      });
      sendStage = { ran: true, leg, dryRun, exitCode: sExit, stdoutTail: sOut.slice(-2000), stderrTail: sErr.slice(-800) };
      console.log(`refresh-send [${leg}${dryRun ? "/dry" : "/LIVE"}]: exit=${sExit}`);

      // Ledger write-back (live sends only): sent-log is APPEND-ONLY —
      // union by sendKey against the remote, never overwrite (the
      // 2026-08-09 double-send incident's rule). send-state rides along.
      if (!dryRun) {
        const localRaw = await fs.readFile(path.join(wsData, "sent-log.json"), "utf-8").catch(() => null);
        if (localRaw && localRaw !== ledgerBefore) {
          type Row = Record<string, unknown>;
          const localRows = JSON.parse(localRaw) as Row[];
          let ledgerOk = false;
          for (let attempt = 1; attempt <= 3 && !ledgerOk; attempt++) {
            const cur = await ghGetShaAndJson(`${DATA_DIR_REPO}/sent-log.json`, ghToken);
            if (!cur) break;
            const remote = cur.data as Row[];
            const have = new Set(remote.map(r => String(r.sendKey)));
            const fresh = localRows.filter(r => !have.has(String(r.sendKey)));
            if (fresh.length === 0) { ledgerOk = true; break; }
            ledgerOk = await ghPutJsonFile(`${DATA_DIR_REPO}/sent-log.json`, ghToken, [...remote, ...fresh],
              cur.sha, `vercel-send ledger [${new Date().toISOString()}]`);
          }
          sendStage.ledgerWritten = ledgerOk;
          if (!ledgerOk) report.errors.push("sent-log write-back failed — sends are still per-sendKey deduped next run via the mirror");
        }
        const stateBuf = await fs.readFile(path.join(wsData, "send-state.json")).catch(() => null);
        if (stateBuf) {
          await ghPutRawFile(`${DATA_DIR_REPO}/send-state.json`, ghToken, stateBuf,
            before.get("send-state.json")?.ghSha ?? null, `vercel-send state [${new Date().toISOString()}]`).catch(() => {});
        }
      }
    }
  }

  if (mode === "live" && written.length > 0 && !writeAborted) {
    // Fresh data (and any new ledger rows) are committed — rebuild the
    // dashboard from them.
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/deploy-code.yml/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
        body: JSON.stringify({ ref: "main" }), signal: AbortSignal.timeout(20_000),
      });
      deployTriggered = res.status === 204;
    } catch { /* non-fatal: data is committed; the next code deploy carries it */ }
  }

  await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  return NextResponse.json({ ...report, parity: verdict.parity, written, writeAborted, deployTriggered, sendStage });
}
