#!/usr/bin/env node
/**
 * EMA prompt precision sender.
 *
 * The 25 EMA micro-survey texts need MINUTE precision (7:34 AM means
 * 7:34 AM). GitHub cron alone can't promise that (5-90 min jitter), so
 * this runs as a LONG-LIVED segment job: launched well before its
 * authority window, it sleeps to the exact second of each prompt and
 * fires instantly. Precision comes from inside the process, not from
 * the scheduler.
 *
 * Segments (ET): morning 06:50-11:50, midday 11:50-16:50,
 * evening 16:50-21:20 — together covering the whole prompt grid
 * (earliest 7:11 AM, latest 9:00 PM). Each cron launches ~40-100 min
 * early; the job sleeps until its window opens and exits when it ends.
 *
 * Data: ema-prompt-schedule.json (written by fetch-data every 30 min) —
 * exact sendAt, the participant's chosen ema_phone, pre-resolved survey
 * links. NO REDCap access needed at fire time. The job re-reads the
 * schedule + pulls the repo every few minutes so completions and
 * newly-enabled participants flow in mid-segment.
 *
 * Rails:
 *   - 30-min grace: a prompt older than 30 min is NEVER sent (the EMA
 *     protocol itself says "if 30 minutes passed, skip").
 *   - Ledger: ema-sent-log.json, one row per (prompt, recipient),
 *     committed+pushed after every send — overlap/restart safe.
 *   - DRY_RUN=true walks everything but transmits nothing.
 *   - SEGMENT=morning|midday|evening|all, SEND_NOW_OVERRIDE + SPEED=fast
 *     for test harnesses.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "private", "data");
const SCHEDULE_PATH = path.join(DATA_DIR, "ema-prompt-schedule.json");
const LEDGER_PATH = path.join(DATA_DIR, "ema-sent-log.json");
const TIMELINE_PATH = path.join(__dirname, "..", "src", "lib", "timeline.ts");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const SEGMENT = process.env.SEGMENT || "all";
const SPEED_FAST = process.env.SPEED === "fast";   // test: no real sleeps
const GRACE_MS = 30 * 60 * 1000;
const QUO_API_KEY = process.env.QUO_API_KEY || "";
const QUO_FROM_NUMBER = process.env.QUO_FROM_NUMBER || "";

const SEGMENTS = {           // ET wall-clock authority windows
  morning: [6 * 60 + 50, 11 * 60 + 50],
  midday: [11 * 60 + 50, 16 * 60 + 50],
  evening: [16 * 60 + 50, 21 * 60 + 20],
  all: [0, 24 * 60],
};

const nowMs = () => {
  const o = process.env.SEND_NOW_OVERRIDE;
  if (!o) return Date.now();
  // Override anchors a virtual clock at start; advances in real time
  // (scaled 60x under SPEED=fast so a "day" plays out in minutes).
  if (!nowMs._base) { nowMs._base = new Date(o).getTime(); nowMs._real = Date.now(); }
  const elapsed = (Date.now() - nowMs._real) * (SPEED_FAST ? 60 : 1);
  return nowMs._base + elapsed;
};

function etMinutes(ms) {
  const s = new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
  const [h, m] = s.split(":").map(Number);
  return (h === 24 ? 0 : h) * 60 + m;
}
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fb; } }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

// Message template: the EMA prompt text from timeline.ts (alert 64+ all
// share the same body; only the survey link differs per report).
function promptTemplate() {
  const ts = fs.readFileSync(TIMELINE_PATH, "utf-8");
  const m = /alertId: 64,[\s\S]*?message: ("(?:[^"\\]|\\.)*"),/.exec(ts);
  if (!m) throw new Error("EMA prompt template (alert 64) not found in timeline.ts");
  return JSON.parse(m[1]);
}

function renderPrompt(tmpl, firstName, link) {
  let out = tmpl.split("[preenrollment_arm_1][first_name]").join(firstName || "");
  out = out.replace(/\[[a-z0-9_]+\]\[survey-link:[a-z0-9_]+\]/gi, link);
  return out;
}

function normalizePhone(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.length === 10) d = "1" + d;
  return d.length === 11 && d.startsWith("1") ? "+" + d : null;
}

// Carrier-history check (dedup vs the Vercel sweeper). Resolves our
// number's OpenPhone ID once, then asks OpenPhone whether an outbound
// message carrying this survey link already went to this participant
// since the slot opened. FAIL OPEN: if the check errors, we send — the
// primary is the protocol-authoritative sender inside the grace window,
// and a lost prompt is worse than the vanishing case (sweeper delivered
// AND the history API is down at the same moment).
let _pnId = null;
async function carrierHasDelivered(phone, link, sendAtMs) {
  try {
    if (!_pnId) {
      const res = await fetch("https://api.openphone.com/v1/phone-numbers", {
        headers: { Authorization: QUO_API_KEY }, signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return false;
      const { data = [] } = await res.json();
      const want = normalizePhone(QUO_FROM_NUMBER);
      const hit = data.find(pn => normalizePhone(pn.number ?? pn.phoneNumber) === want) || (data.length === 1 ? data[0] : null);
      if (!hit) return false;
      _pnId = hit.id;
    }
    const params = new URLSearchParams({
      phoneNumberId: _pnId, maxResults: "20",
      createdAfter: new Date(sendAtMs - 2 * 60 * 1000).toISOString(),
    });
    params.append("participants", phone);
    const res = await fetch(`https://api.openphone.com/v1/messages?${params}`, {
      headers: { Authorization: QUO_API_KEY }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const { data = [] } = await res.json();
    return data.some(m => String(m.direction || "") !== "incoming" && String(m.text ?? m.content ?? "").includes(link));
  } catch { return false; }
}

async function sendSMS(to, body) {
  if (DRY_RUN) { console.log(`  [DRY] sms → ${to} @ ${new Date(nowMs()).toISOString()}`); return; }
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch("https://api.openphone.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: QUO_API_KEY },
        body: JSON.stringify({ content: body, from: QUO_FROM_NUMBER, to: [to] }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`OpenPhone ${res.status}: ${await res.text()}`);
      return;
    } catch (e) {
      if (a === 3) throw e;
      await new Promise(r => setTimeout(r, 1500 * a));
    }
  }
}

function gitPushLedger() {
  if (DRY_RUN || process.env.NO_GIT === "1") return;
  try {
    execSync(
      `git add "${LEDGER_PATH}" && (git diff --cached --quiet || (git -c user.name="github-actions[bot]" -c user.email="github-actions[bot]@users.noreply.github.com" commit -m "ema prompt send" -q && (git pull --rebase --autostash -X theirs origin main -q; git push -q)))`,
      { cwd: path.join(__dirname, ".."), stdio: "pipe", timeout: 60_000 }
    );
  } catch (e) { console.warn(`  ledger push deferred: ${String(e.message).slice(0, 120)}`); }
}

function gitRefresh() {
  if (process.env.NO_GIT === "1") return;
  try {
    execSync("git pull --rebase --autostash -X theirs origin main -q", { cwd: path.join(__dirname, ".."), stdio: "pipe", timeout: 60_000 });
  } catch { /* keep running on the copy we have */ }
}

async function main() {
  const [winStart, winEnd] = SEGMENTS[SEGMENT] || SEGMENTS.all;
  const tmpl = promptTemplate();
  const participants = readJson(path.join(DATA_DIR, "participants.json"), { participants: [] }).participants;
  const nameByPid = Object.fromEntries(participants.map(p => [p.pid, p.contact?.firstName || ""]));

  console.log(`EMA prompt sender: segment=${SEGMENT} (${Math.floor(winStart/60)}:${String(winStart%60).padStart(2,"0")}–${Math.floor(winEnd/60)}:${String(winEnd%60).padStart(2,"0")} ET) dry=${DRY_RUN}`);

  // Sleep until the authority window opens (cron launches us early).
  while (etMinutes(nowMs()) < winStart && !SPEED_FAST) {
    await new Promise(r => setTimeout(r, 20_000));
  }

  let sent = 0, skippedLate = 0, refreshCounter = 0;
  while (true) {
    const t = nowMs();
    const nowEt = etMinutes(t);
    if (nowEt >= winEnd || nowEt < winStart - 120) break;  // window over (or clock insane)

    // Re-read schedule + ledger each loop; pull repo every ~5 min so
    // completions and newly-enabled participants arrive mid-segment.
    if (refreshCounter++ % 10 === 0) gitRefresh();
    const schedule = readJson(SCHEDULE_PATH, []);
    const ledger = readJson(LEDGER_PATH, []);
    // Terminal = sent OR skipped (late/bad-data): none of these may be
    // re-attempted. Real rows always block; dry rows only block within a
    // dry run (a rehearsal must never satisfy "already sent" for real).
    const TERMINAL = new Set(["sent", "skipped_late", "skipped", "already_delivered"]);
    const done = new Set(
      ledger.filter(e => TERMINAL.has(e.status) && (!e.dryRun || DRY_RUN)).map(e => e.key)
    );
    let dirty = false;

    for (const row of schedule) {
      { const n = Number(String(row.pid).replace(/\D/g, "")); if (n >= 1000 && n <= 1999) continue; } // HARD RULE: cohort 1 never gets EMA
      const at = new Date(row.sendAt).getTime();
      if (isNaN(at) || at > t) continue;                       // not yet
      const k = `${row.pid}|${row.wave}|${row.key}`;
      if (done.has(k)) continue;                               // already sent
      if (t - at > GRACE_MS) {                                 // >30 min late: protocol says skip
        dirty = true; ledger.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "skipped_late", sendAt: row.sendAt, at: new Date(t).toISOString(), dryRun: DRY_RUN || undefined });
        done.add(k); skippedLate++;
        continue;
      }
      const phone = normalizePhone(row.phone);
      const link = row.surveyLink;
      if (!phone || !link) {
        dirty = true; ledger.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "skipped", error: !phone ? `bad phone "${row.phone}"` : "no survey link", sendAt: row.sendAt, dryRun: DRY_RUN || undefined });
        done.add(k);
        continue;
      }
      try {
        // Late-send guard: past ~2 min the slot belongs to a backstop —
        // the Mac sender takes over at 3 min, the Vercel sweeper at 10 —
        // and either may already have delivered while we were down. The
        // carrier's own history is the shared source of truth: check it
        // before sending so a rescued prompt is never sent twice. On-time
        // sends (the normal path, seconds after the slot) skip this.
        if (t - at > 2 * 60 * 1000 && !DRY_RUN) {
          const delivered = await carrierHasDelivered(phone, link, at);
          if (delivered) {
            dirty = true; ledger.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "already_delivered", channel: "sms", recipient: phone, sendAt: row.sendAt, at: new Date(t).toISOString(), note: "found in carrier history (backstop leg got it)" });
            done.add(k);
            console.log(`  ◦ ${row.pid} ${row.key}: already delivered per carrier history — a backstop leg got it`);
            continue;
          }
        }
        await sendSMS(phone, renderPrompt(tmpl, nameByPid[row.pid], link));
        sent++;
        dirty = true; ledger.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "sent", channel: "sms", recipient: phone, sendAt: row.sendAt, at: new Date(t).toISOString(), latencySec: Math.round((t - at) / 1000), dryRun: DRY_RUN || undefined });
        console.log(`  ✓ ${row.pid} ${row.dayLabel} ${row.timeLabel} → ${phone} (${Math.round((t - at) / 1000)}s after slot)`);
      } catch (e) {
        dirty = true; ledger.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "failed", error: e.message, sendAt: row.sendAt, dryRun: DRY_RUN || undefined });
        console.error(`  ✗ ${row.pid} ${row.promptKey}: ${e.message}`);
      }
      done.add(k);
    }
    if (dirty) { writeJson(LEDGER_PATH, ledger); gitPushLedger(); }

    // Sleep until the next upcoming prompt in-window (or poll every 20s).
    const upcoming = schedule
      .map(r => new Date(r.sendAt).getTime())
      .filter(x => x > t && etMinutes(x) < winEnd)
      .sort((a, b) => a - b)[0];
    const waitMs = upcoming ? Math.min(Math.max(upcoming - nowMs(), 250), 60_000) : 20_000;
    await new Promise(r => setTimeout(r, SPEED_FAST ? 50 : waitMs));
  }
  console.log(`Segment done. sent=${sent} skippedLate=${skippedLate}`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
