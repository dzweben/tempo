#!/usr/bin/env node
/**
 * Daily server audit — the plumbing check a coordinator would do by
 * hand every morning, automated:
 *
 *   1. What was SUPPOSED to send yesterday (queue + staged recovery +
 *      EMA prompt schedule)?
 *   2. What ACTUALLY sent (both ledgers), to whom, on which channel?
 *   3. Reconcile: every planned item must be sent, failed, skipped, or
 *      explainably dropped (survey completed before its slot). Anything
 *      unaccounted for is a RED flag — that's the failure mode that
 *      once cost us two silent weeks.
 *   4. Infrastructure health: workflow runs, data freshness, kill
 *      switch, EMA prompt delivery latency.
 *
 * Output: private/data/audits/YYYY-MM-DD.json + audits/index.json,
 * rendered by the dashboard's Daily Audit tab.
 *
 * Env: AUDIT_DATE (optional YYYY-MM-DD, default = yesterday ET),
 *      GITHUB_TOKEN + GITHUB_REPOSITORY (for run health, optional).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "private", "data");
const AUDIT_DIR = path.join(DATA_DIR, "audits");
const ET = "America/New_York";

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fb; } };
const etDay = (x) => new Date(x).toLocaleDateString("en-CA", { timeZone: ET });

// Audit date: yesterday in ET unless overridden.
const AUDIT_DATE = process.env.AUDIT_DATE || etDay(Date.now() - 24 * 3600 * 1000);

const participants = readJson(path.join(DATA_DIR, "participants.json"), { participants: [] }).participants;
const byPid = Object.fromEntries(participants.map(p => [p.pid, p]));
const sentLog = readJson(path.join(DATA_DIR, "sent-log.json"), []);
const emaLog = readJson(path.join(DATA_DIR, "ema-sent-log.json"), []);
const candidates = readJson(path.join(DATA_DIR, "send-candidates.json"), []);
const recovery = readJson(path.join(DATA_DIR, "recovery-sends.json"), []);
const emaSchedule = readJson(path.join(DATA_DIR, "ema-prompt-schedule.json"), []);
const lastFetch = readJson(path.join(DATA_DIR, "last-fetch.json"), {});
const postponed = new Set(readJson(path.join(DATA_DIR, "postponed.json"), []).map(s => String(s).toLowerCase()));

// ---------- 1+2. planned vs actual for AUDIT_DATE ----------
const planned = [...candidates, ...recovery].filter(d => etDay(d.scheduledAt) === AUDIT_DATE);
const realRows = sentLog.filter(e => !e.dryRun);
const rowsByDueKey = {};
for (const e of realRows) {
  const k = e.id;
  (rowsByDueKey[k] ||= []).push(e);
}

function cycleComplete(d) {
  // Mirror of the sender's completion re-check, evaluated against the
  // CURRENT data — explains "no send" for items completed before their slot.
  const wave = byPid[d.pid]?.waves?.[d.wave];
  if (!wave) return false;
  let which = null, idx = -1;
  if (d.alertId >= 48 && d.alertId <= 53) { which = "sts1"; idx = d.alertId - 48; }
  else if (d.alertId >= 54 && d.alertId <= 59) { which = "sts1"; idx = d.alertId - 54; }
  else if (d.alertId >= 89 && d.alertId <= 91) { which = "sts2"; idx = d.alertId - 89; }
  else if (d.alertId >= 93 && d.alertId <= 95) { which = "sts2"; idx = d.alertId - 93; }
  else if (d.kind === "ema_enable") return !!wave.ema?.active;
  else if (String(d.kind).startsWith("payment")) return wave.ema?.paymentRedeemed === true;
  else return false;
  return wave[which]?.cycles?.[idx]?.complete === 2;
}

const buckets = { sent: [], failed: [], skipped: [], completedBeforeSlot: [], postponed: [], slotStillOpen: [], unaccounted: [] };
const now = Date.now();
for (const d of planned) {
  const key = `${d.pid}|${d.alertId}|${d.scheduledAt}`;
  const rows = rowsByDueKey[key] || [];
  const summary = {
    pid: d.pid, wave: d.wave, kind: d.kind, instrument: d.instrument,
    scheduledAt: d.scheduledAt,
    channels: rows.map(r => `${r.channel}:${r.status}${r.daysLate ? ` (${r.daysLate}d late)` : ""}`),
  };
  if (rows.some(r => r.status === "sent")) buckets.sent.push(summary);
  else if (rows.some(r => r.status === "failed")) buckets.failed.push(summary);
  else if (rows.some(r => r.status === "skipped")) buckets.skipped.push(summary);
  else if (postponed.has(String(d.pid).toLowerCase())) buckets.postponed.push(summary);
  else if (cycleComplete(d)) buckets.completedBeforeSlot.push(summary);
  else if (new Date(d.scheduledAt).getTime() > now - 2 * 24 * 3600 * 1000) buckets.slotStillOpen.push(summary); // day-shift window still open
  else buckets.unaccounted.push(summary);
}

// ---------- EMA prompts for the day ----------
const emaPlanned = emaSchedule.filter(r => etDay(r.sendAt) === AUDIT_DATE);
const emaRows = emaLog.filter(e => !e.dryRun && etDay(e.at || e.sendAt) === AUDIT_DATE);
const emaSent = emaRows.filter(e => e.status === "sent");
const latencies = emaSent.map(e => e.latencySec).filter(x => x != null);
// A planned prompt whose slot+grace has passed with NO terminal ledger
// row (sent / skipped / failed) means no sender job ever touched it —
// the exact failure mode a dropped segment start would produce. RED.
const TERMINAL_EMA = new Set(["sent", "skipped_late", "skipped", "failed", "already_delivered"]);
const emaTerminalKeys = new Set(emaLog.filter(e => !e.dryRun && TERMINAL_EMA.has(e.status)).map(e => e.key));
const emaUnaccounted = emaPlanned.filter(r =>
  new Date(r.sendAt).getTime() < Date.now() - 35 * 60 * 1000 &&
  !emaTerminalKeys.has(`${r.pid}|${r.wave}|${r.key}`)
);
const emaSummary = {
  planned: emaPlanned.length,
  sent: emaSent.length,
  // Delivered by the off-GitHub Vercel sweeper while a segment job was
  // down (primary found it in carrier history and stood down).
  sweeperRescued: emaRows.filter(e => e.status === "already_delivered").length,
  skippedLate: emaRows.filter(e => e.status === "skipped_late").length,
  failed: emaRows.filter(e => e.status === "failed").length,
  unaccounted: emaUnaccounted.length,
  unaccountedDetail: emaUnaccounted.map(r => ({ pid: r.pid, wave: r.wave, key: r.key, sendAt: r.sendAt })),
  maxLatencySec: latencies.length ? Math.max(...latencies) : null,
  medianLatencySec: latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null,
};

// ---------- infrastructure health ----------
async function workflowHealth() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || "YOUR-GITHUB-ORG/YOUR-DATA-REPO";
  if (!token) return { note: "no GITHUB_TOKEN — run health unavailable" };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?created=${AUDIT_DATE}..${AUDIT_DATE}&per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { note: `runs API ${res.status}` };
    const { workflow_runs = [] } = await res.json();
    const out = {};
    for (const r of workflow_runs) {
      const k = r.name;
      out[k] ||= { success: 0, failure: 0, cancelled: 0, other: 0 };
      const c = r.conclusion || "other";
      out[k][c] = (out[k][c] || 0) + 1;
    }
    return out;
  } catch (e) { return { note: `runs API error: ${e.message}` }; }
}

async function killSwitchState() {
  // The workflow passes the repo variable directly (GITHUB_TOKEN can't
  // always read the variables API — that produced false "unknown"s).
  if (process.env.SEND_LIVE) {
    return process.env.SEND_LIVE === "true" ? "LIVE" : "FROZEN (dry-run)";
  }
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || "YOUR-GITHUB-ORG/YOUR-DATA-REPO";
  if (!token) return "unknown";
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/variables/SEND_LIVE`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return "unknown";
    return (await res.json()).value === "true" ? "LIVE" : "FROZEN (dry-run)";
  } catch { return "unknown"; }
}

// ---------- verdict ----------
const main = async () => {
  const runs = await workflowHealth();
  const sendMode = await killSwitchState();

  const fetchAgeMin = lastFetch.timestamp ? Math.round((now - new Date(lastFetch.timestamp).getTime()) / 60000) : null;
  const problems = [];
  if (buckets.unaccounted.length) problems.push(`${buckets.unaccounted.length} planned send(s) UNACCOUNTED FOR`);
  if (buckets.failed.length) problems.push(`${buckets.failed.length} send failure(s)`);
  if (emaSummary.failed) problems.push(`${emaSummary.failed} EMA prompt failure(s)`);
  if (emaSummary.unaccounted) problems.push(`${emaSummary.unaccounted} EMA prompt(s) UNACCOUNTED — no sender job touched them`);
  const warnings = [];
  if (lastFetch.staleEmaAnchors?.length) warnings.push(`${lastFetch.staleEmaAnchors.length} enabled EMA wave(s) withheld pending re-anchor: ${lastFetch.staleEmaAnchors.map(x => `${x.pid} W${x.wave}`).join(", ")}`);
  if (buckets.skipped.length) warnings.push(`${buckets.skipped.length} skipped (unresolved link)`);
  if (emaSummary.skippedLate) warnings.push(`${emaSummary.skippedLate} EMA prompt(s) protocol-skipped (late)`);
  if (sendMode !== "LIVE") warnings.push(`sending is ${sendMode}`);
  // backstop leg (the always-on Mac that holds the EMA backstop sender):
  // it commits a daily heartbeat tagged leg="backstop-agent". Silence >26h,
  // or a heartbeat from a decommissioned host, means that redundancy
  // layer is down — GitHub + Vercel legs still cover delivery, but say so.
  const EXPECTED_LEG = "backstop-agent";
  const hb = readJson(path.join(DATA_DIR, "local-timer-heartbeat.json"), null);
  if (hb?.at) {
    const ageH = Math.round((now - new Date(hb.at).getTime()) / 3600000);
    if (ageH > 26) warnings.push(`backstop EMA leg silent for ${ageH}h (EMA still covered by GitHub + Vercel legs)`);
    else if (hb.leg && hb.leg !== EXPECTED_LEG) warnings.push(`EMA backstop heartbeat came from "${hb.leg}", expected "${EXPECTED_LEG}" — is the backstop agent running?`);
  } else {
    warnings.push(`no backstop EMA-leg heartbeat on record`);
  }
  // REDCap is down nightly ~12:40–7 AM ET, so several hours of staleness
  // is expected when the morning audit runs — only flag daytime staleness.
  const etHour = Number(new Date().toLocaleString("en-US", { timeZone: ET, hour: "numeric", hour12: false }));
  const staleLimit = etHour < 9 ? 540 : 120;
  if (fetchAgeMin != null && fetchAgeMin > staleLimit) warnings.push(`data ${fetchAgeMin} min stale`);
  for (const [wf, c] of Object.entries(runs)) {
    if (c && typeof c === "object" && (c.failure || 0) > 0) warnings.push(`${wf}: ${c.failure} failed run(s)`);
  }
  const verdict = problems.length ? "RED" : warnings.length ? "YELLOW" : "GREEN";

  const report = {
    date: AUDIT_DATE,
    generatedAt: new Date().toISOString(),
    verdict, problems, warnings,
    sendMode,
    dataFreshnessMin: fetchAgeMin,
    planned: planned.length,
    counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    detail: buckets,
    ema: emaSummary,
    workflowRuns: runs,
    totals: {
      participants: participants.length,
      queueUpcoming: candidates.filter(d => new Date(d.scheduledAt).getTime() > now).length,
      sentAllTime: realRows.filter(e => e.status === "sent").length,
    },
  };

  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const index = readJson(path.join(AUDIT_DIR, "index.json"), []);

  fs.writeFileSync(path.join(AUDIT_DIR, `${AUDIT_DATE}.json`), JSON.stringify(report, null, 2));
  const entry = { date: AUDIT_DATE, verdict: report.verdict, problems: report.problems.length, warnings: report.warnings.length, generatedAt: report.generatedAt };
  const i = index.findIndex(x => x.date === AUDIT_DATE);
  if (i >= 0) index[i] = entry; else index.push(entry);
  index.sort((a, b) => b.date.localeCompare(a.date));
  fs.writeFileSync(path.join(AUDIT_DIR, "index.json"), JSON.stringify(index, null, 2));
  console.log(`Audit ${AUDIT_DATE}: ${report.verdict}${report.problems.length ? " — " + report.problems.join("; ") : ""}${report.warnings.length ? " | warn: " + report.warnings.join("; ") : ""}`);
};

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
