#!/usr/bin/env node
/**
 * the study outgoing-message sender.
 *
 * Runs from GitHub Actions as part of the refresh pipeline (fetch →
 * SEND → commit → deploy), so every send decision is made against
 * REDCap data fetched MINUTES earlier — the send-time completion
 * re-check. A reminder only exists in due-reminders.json if its survey
 * is still incomplete / payment unredeemed as of that fetch.
 *
 * Send-window model (GitHub cron is unreliable — runs are delayed or
 * skipped routinely, so a tight ±minutes window silently drops sends):
 *   fire everything with scheduledAt in (windowStart, now], where
 *   windowStart = max(lastRunAt − 5 min overlap, now − CATCHUP_MS).
 *   The sent-log dedupes the overlap. First run ever (no state file)
 *   seeds windowStart = now → clean forward-only cutover, no backlog
 *   blast at launch.
 *
 * Safety rails:
 *   - Quiet hours: no sends before 8:00 AM or after 9:30 PM Eastern;
 *     missed items catch up next run within the horizon.
 *   - Unresolved survey link → the message is NOT sent (logged
 *     "skipped") — nobody gets a "[SURVEY LINK PENDING]" text.
 *   - Hard cap per run (default 1500 messages) — a queue-generation bug
 *     can't mass-blast; the run aborts loudly instead.
 *   - postponed.json: list of PIDs to silence entirely.
 *   - DRY_RUN=true → full decision pipeline + log, zero real sends.
 *
 * Env: GMAIL_USER, GMAIL_APP_PASSWORD, QUO_API_KEY, QUO_FROM_NUMBER,
 *      REDCAP_API_TOKEN, REDCAP_API_URL, DRY_RUN, MAX_SENDS_PER_RUN.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "private", "data");
const PARTICIPANTS_PATH = path.join(DATA_DIR, "participants.json");
// send-candidates.json = due-reminders plus items due within the last
// 24h. The display queue (due-reminders.json) is future-only by design,
// which starved the sender — "due" items are by definition just-past.
const CANDIDATES_PATH = path.join(DATA_DIR, "send-candidates.json");
const DUE_PATH = path.join(DATA_DIR, "due-reminders.json");
const SENT_LOG_PATH = path.join(DATA_DIR, "sent-log.json");
const POSTPONED_PATH = path.join(DATA_DIR, "postponed.json");
const STATE_PATH = path.join(DATA_DIR, "send-state.json");
// One-time recovery blasts (e.g. the missed July 2026 STS cycle). The
// file can sit staged in the repo indefinitely — items are ONLY fired
// when the run is explicitly launched with RECOVERY=true.
const RECOVERY_PATH = path.join(DATA_DIR, "recovery-sends.json");
const RECOVERY = (process.env.RECOVERY || "").toLowerCase() === "true";

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false"; // safe default: dry
const CATCHUP_MS = 18 * 3600 * 1000;      // never send anything older than 18h
const OVERLAP_MS = 5 * 60 * 1000;         // re-examine 5 min before lastRun (dedup covers it)
const MAX_SENDS_PER_RUN = Number(process.env.MAX_SENDS_PER_RUN || 1500);

const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const QUO_API_KEY = process.env.QUO_API_KEY || "";
const QUO_FROM_NUMBER = process.env.QUO_FROM_NUMBER || "";
const REDCAP_API_URL = process.env.REDCAP_API_URL || "https://YOUR-INSTITUTION.edu/redcap/api/";
const LITE_TOKEN = process.env.REDCAP_API_TOKEN || "";

// --- IO helpers ---
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// --- Eastern-time helpers (the whole study runs on ET) ---
function easternParts(epochMs = Date.now()) {
  const s = new Date(epochMs).toLocaleString("en-US", {
    timeZone: "America/New_York", hour12: false,
    hour: "2-digit", minute: "2-digit",
  });
  const [h, m] = s.split(":").map(Number);
  return { hour: h === 24 ? 0 : h, minute: m };
}
function inQuietHours(epochMs = Date.now()) {
  const { hour, minute } = easternParts(epochMs);
  const mins = hour * 60 + minute;
  return mins < 8 * 60 || mins > 21 * 60 + 30; // before 8:00 AM or after 9:30 PM ET
}
function fmtExpireDate(iso) {
  if (!iso) return "[expire date pending]";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "[expire date pending]";
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric",
  });
}

// --- Idempotency: one log row per (reminder, channel, recipient) ---
function dueKey(d) { return `${d.pid}|${d.alertId}|${d.scheduledAt}`; }
function sendKey(d, channel, recipient) { return `${dueKey(d)}|${channel}|${recipient}`; }

// --- Template rendering ---
function renderMessage(template, participant, surveyLinks, expireDate) {
  if (!template) return "";
  let out = template;
  const c = participant.contact || {};
  const subs = {
    "[preenrollment_arm_1][first_name]": c.firstName || "",
    "[preenrollment_arm_1][last_name]": c.lastName || "",
    "[preenrollment_arm_1][parent_name]": c.parentName || "",
    "[preenrollment_arm_1][email]": c.email || "",
    "[preenrollment_arm_1][phone_primary]": c.phonePrimary || "",
    "[preenrollment_arm_1][phone_secondary]": c.phoneSecondary || "",
    "[name]": c.firstName || "",
    "[expire_date]": fmtExpireDate(expireDate),
  };
  for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v);
  out = out.replace(/\[([a-z0-9_]+)\]\[survey-link:([a-z0-9_]+)\]/gi, (_m, evt, instr) => {
    return surveyLinks[`${evt}|${instr}`] || "[SURVEY LINK PENDING]";
  });
  out = out.split("[survey link]").join(surveyLinks.__first || "[SURVEY LINK PENDING]");
  return out;
}

// --- Survey-link resolver (just-in-time, wave-corrected) ---
// Templates are authored against y2/y3 event slugs; a wave-1 participant
// must resolve against their _y1_ event or they'd get a YEAR-2 link.
function remapEventForWave(evt, wave) {
  return String(evt).replace(/_y\d(_arm_)/, `_y${wave}$1`);
}
const linkCache = {};
async function resolveSurveyLink(recordId, eventName, instrument) {
  const key = `${recordId}|${eventName}|${instrument}`;
  if (key in linkCache) return linkCache[key];
  if (!LITE_TOKEN) return null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const body = new URLSearchParams({
        token: LITE_TOKEN, content: "surveyLink", format: "json",
        record: recordId, event: eventName, instrument,
      });
      const res = await fetch(REDCAP_API_URL, {
        method: "POST", body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) break; // REDCap says no such link — retrying won't help
      const txt = (await res.text()).trim();
      const link = txt.startsWith("http") ? txt : null;
      linkCache[key] = link;
      return link;
    } catch {
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  linkCache[key] = null;
  return null;
}

// --- Senders (with transient retry) ---
let mailTransporter = null;
function getMailer() {
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false,
      pool: true, maxConnections: 1, maxMessages: Infinity,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return mailTransporter;
}
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      const transient = /timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|429|5\d\d|socket|network/i.test(String(err));
      if (!transient || attempt === 3) throw err;
      console.warn(`    retry ${attempt} for ${label}: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}
async function sendEmail(to, subject, body) {
  if (DRY_RUN) { console.log(`  [DRY] email → ${to}: ${subject}`); return; }
  if (!GMAIL_USER) throw new Error("GMAIL_USER not set");
  await withRetry(() => getMailer().sendMail({
    from: `"TEMPO" <${GMAIL_USER}>`,
    to, subject, text: body,
  }), `email ${to}`);
}
function normalizePhone(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10) d = "1" + d;
  if (d.length !== 11 || !d.startsWith("1")) return null;
  return "+" + d;
}
async function sendSMS(to, body) {
  const e164 = normalizePhone(to);
  if (!e164) throw new Error(`Bad phone "${to}"`);
  if (DRY_RUN) { console.log(`  [DRY] sms → ${e164}: ${body.slice(0, 60).replace(/\n/g, " ")}…`); return; }
  if (!QUO_API_KEY || !QUO_FROM_NUMBER) throw new Error("QUO_API_KEY / QUO_FROM_NUMBER not set");
  await withRetry(async () => {
    const res = await fetch("https://api.openphone.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: QUO_API_KEY },
      body: JSON.stringify({ content: body, from: QUO_FROM_NUMBER, to: [e164] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`OpenPhone ${res.status}: ${await res.text()}`);
  }, `sms ${e164}`);
}

// --- Timeline template lookup (parsed from src/lib/timeline.ts) ---
function loadTimeline() {
  const tsPath = path.join(__dirname, "..", "src", "lib", "timeline.ts");
  const ts = fs.readFileSync(tsPath, "utf-8");
  const entries = [];
  const blockRegex = /\{\s*alertId:\s*(\d+),\s*wave:\s*(\d)\s*as WaveYear,\s*kind:\s*"([^"]+)",\s*instrument:\s*("(?:[^"\\]|\\.)*"),[\s\S]*?message:\s*(null|"(?:[^"\\]|\\.)*"),\s*\},/g;
  let m;
  while ((m = blockRegex.exec(ts)) !== null) {
    entries.push({
      alertId: Number(m[1]),
      wave: Number(m[2]),
      kind: m[3],
      instrument: JSON.parse(m[4]),
      message: m[5] === "null" ? null : JSON.parse(m[5]),
    });
  }
  if (entries.length === 0) throw new Error("Parsed 0 timeline entries — timeline.ts format changed?");
  return entries;
}
const TIMELINE = loadTimeline();
function findTemplate(alertId, wave, kind) {
  return TIMELINE.find(t => t.alertId === alertId && t.wave === wave)
      || TIMELINE.find(t => t.alertId === alertId)
      || TIMELINE.find(t => t.kind === kind && t.wave === wave);
}

// Which channels each alert kind uses (mirrors the Timeline destinationSpec).
// EMA prompts are NOT here — REDCap sends those natively.
const KIND_CHANNELS = {
  sts1_invite:      { sms: true,  email: true  },
  sts1_followup:    { sms: true,  email: true  },
  sts2_invite:      { sms: true,  email: true  },
  sts2_followup:    { sms: true,  email: true  },
  athome_sms:       { sms: true,  email: false },
  athome_email:     { sms: false, email: true  },
  ema_enable:       { sms: true,  email: false },
  payment_email:    { sms: true,  email: false },
  payment_followup: { sms: true,  email: false },
  payment_expire:   { sms: true,  email: false },
};

// Human subject lines for emails (never expose internal alert names).
function emailSubject(kind) {
  if (kind.startsWith("sts")) return "the study – Screen Time Survey";
  if (kind.startsWith("athome")) return "the study – At-Home Survey";
  if (kind.startsWith("payment")) return "the study – Compensation";
  return "the study";
}

// --- Main ---
// For recovery items: never message someone who has since completed the
// survey. Maps an STS alertId back to its cycle and checks live data.
function stsStillIncomplete(participant, d) {
  const wave = participant?.waves?.[d.wave];
  if (!wave) return false;
  let which = null, idx = -1;
  if (d.alertId >= 48 && d.alertId <= 53) { which = "sts1"; idx = d.alertId - 48; }        // invites
  else if (d.alertId >= 54 && d.alertId <= 59) { which = "sts1"; idx = d.alertId - 54; }   // follow-up reminders
  else if (d.alertId >= 89 && d.alertId <= 91) { which = "sts2"; idx = d.alertId - 89; }   // invites
  else if (d.alertId >= 93 && d.alertId <= 95) { which = "sts2"; idx = d.alertId - 93; }   // follow-up reminders
  else return true; // non-STS recovery kinds: no cycle to check
  const c = wave[which]?.cycles?.[idx];
  return !c || c.complete !== 2;
}

async function main() {
  const data = readJson(PARTICIPANTS_PATH, { participants: [] });
  // Prefer the sender's working set (includes last-24h); fall back to the
  // display queue if a fetch predates the split.
  const due = readJson(CANDIDATES_PATH, null) ?? readJson(DUE_PATH, []);
  const sentLog = readJson(SENT_LOG_PATH, []);
  const postponed = new Set((readJson(POSTPONED_PATH, [])).map(s => String(s).toLowerCase()));
  // Opt-out registry (participant texted STOP): belt at send time — the
  // queue generator already excludes these PIDs, but never trust a stale
  // candidates file with someone's opt-out. See opt-outs.json.
  const optedOut = new Set(Object.keys(readJson(path.join(DATA_DIR, "opt-outs.json"), {})).filter(k => !k.startsWith("_")));
  const state = readJson(STATE_PATH, null);

  // TEST-ONLY: freeze "now" to a specific instant (ISO) to exercise the
  // window/firing logic in dry runs. Never set in production.
  const nowOverride = process.env.SEND_NOW_OVERRIDE ? new Date(process.env.SEND_NOW_OVERRIDE).getTime() : NaN;
  const now = isFinite(nowOverride) ? nowOverride : Date.now();
  if (isFinite(nowOverride)) console.log(`⚠ SEND_NOW_OVERRIDE active: now = ${new Date(now).toISOString()}`);

  // Window: (windowStart, now]. First run ever = forward-only cutover.
  let windowStart;
  if (state?.lastRunAt) {
    const last = new Date(state.lastRunAt).getTime();
    windowStart = Math.max(last - OVERLAP_MS, now - CATCHUP_MS);
  } else {
    windowStart = now;
    console.log("No send-state.json — FIRST RUN: forward-only from now (no backlog).");
  }

  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no real sends)" : "LIVE"}`);
  console.log(`Loaded ${data.participants.length} participants, ${due.length} due, ${sentLog.length} sent-log entries`);
  console.log(`Window: ${new Date(windowStart).toISOString()} → ${new Date(now).toISOString()}`);

  if (inQuietHours(now)) {
    if (DRY_RUN) {
      // A dry run sends nothing, so there is nothing to be quiet about —
      // proceed so the decision pipeline can be verified at any hour.
      console.log("Quiet hours — but DRY RUN sends nothing, continuing for verification.");
    } else {
      console.log("Quiet hours (before 8 AM / after 9:30 PM ET) — no sends this run; items catch up next run.");
      // Do NOT advance lastRunAt: the skipped items stay inside the next window.
      return;
    }
  }

  // Dedup ledger: REAL sends only. Dry-run rows are a rehearsal's paper
  // trail — counting them would let a rehearsal block the real send
  // (the July recovery would have silently no-op'd against its own
  // dry-run). A dry run must never satisfy "already sent."
  const doneKeys = new Set(
    sentLog.filter(e => e.status === "sent" && !e.dryRun)
           .map(e => e.sendKey || `${e.id}|${e.channel}|${e.recipient}`)
  );
  const participantByPid = Object.fromEntries(data.participants.map(p => [p.pid, p]));

  const fires = due.filter(d => {
    if (optedOut.has(String(d.pid))) return false;  // texted STOP
    if (postponed.has(String(d.pid).toLowerCase())) return false;
    if (d.complete) return false;
    if (d.mode === "manual") return false;
    const t = new Date(d.scheduledAt).getTime();
    return !isNaN(t) && t > windowStart && t <= now;
  });

  console.log(`Reminders in window: ${fires.length}`);

  // Staged recovery items (recovery-sends.json) — coordinator-approved
  // catch-up sends with their own scheduledAt values. Processed on EVERY
  // run, time-gated exactly like normal items, so a staged batch rolls
  // out on its planned days with no manual dispatching. RECOVERY=true
  // (manual dispatch) overrides the time gate and fires all staged items
  // immediately. Ledger dedup, quiet hours, link guards, and live
  // completion/cycle re-checks always apply.
  {
    const recovery = readJson(RECOVERY_PATH, []);
    const byPid = Object.fromEntries(data.participants.map(p => [p.pid, p]));
    let added = 0, dropped = 0, notYet = 0;
    for (const d of recovery) {
      if (optedOut.has(String(d.pid))) { dropped++; continue; }  // texted STOP
      if (postponed.has(String(d.pid).toLowerCase())) { dropped++; continue; }
      // Live re-checks: STS completed since staging → drop. EMA cycle
      // already running (participant enabled on their own) → drop.
      if (!stsStillIncomplete(byPid[d.pid], d)) { dropped++; continue; }
      if (d.kind === "ema_enable" && byPid[d.pid]?.waves?.[d.wave]?.ema?.active) { dropped++; continue; }
      const t = new Date(d.scheduledAt).getTime();
      const due = RECOVERY || (!isNaN(t) && t > windowStart && t <= now);
      if (!due) { notYet++; continue; }
      fires.push(d); added++;
    }
    if (recovery.length > 0) {
      console.log(`Recovery: +${added} due now, ${notYet} scheduled later, ${dropped} dropped (completed/active/postponed)${RECOVERY ? " [RECOVERY override: time gate bypassed]" : ""}`);
    }
  }

  // Safety cap counts CHANNEL sends (a reminder can be 2 SMS + 1 email).
  const estMessages = fires.reduce((n, d) => {
    const ch = KIND_CHANNELS[d.kind] || {};
    const p = participantByPid[d.pid];
    const phones = [p?.contact?.phonePrimary, p?.contact?.phoneSecondary].filter(Boolean).length;
    return n + (ch.sms ? Math.max(phones, 0) : 0) + (ch.email && p?.contact?.email ? 1 : 0);
  }, 0);
  if (estMessages > MAX_SENDS_PER_RUN) {
    throw new Error(`Would send ~${estMessages} messages (cap ${MAX_SENDS_PER_RUN}). Refusing — inspect the queue; raise MAX_SENDS_PER_RUN only if this volume is truly expected.`);
  }

  let sent = 0, failed = 0, skipped = 0;

  for (const d of fires) {
    const p = participantByPid[d.pid];
    if (!p) { console.warn(`  ! pid ${d.pid} not in participants.json — skipping`); continue; }
    const tmpl = findTemplate(d.alertId, d.wave, d.kind);
    if (!tmpl?.message) { console.warn(`  ! no template for alert ${d.alertId}/w${d.wave} — skipping`); continue; }

    // Resolve survey links just-in-time, remapping event slugs to the
    // participant's wave (template slugs are authored as y2/y3).
    const linkSlots = [...(tmpl.message.matchAll(/\[([a-z0-9_]+)\]\[survey-link:([a-z0-9_]+)\]/gi) || [])];
    const surveyLinks = {};
    for (const [, evt, instr] of linkSlots) {
      const wavedEvt = remapEventForWave(evt, d.wave);
      const link = d.surveyLink || await resolveSurveyLink(p.recordId, wavedEvt, instr);
      if (link) {
        surveyLinks[`${evt}|${instr}`] = link;
        if (!surveyLinks.__first) surveyLinks.__first = link;
      }
    }

    // Progressive enable-nudge ladder (approved 2026-08-24): the weekly
    // roll-forward resends the enable invite up to 4 times; later
    // attempts acknowledge the repeat instead of reading like a bot on
    // loop. Attempt number = distinct prior real-send DATES for this
    // pid+wave (one attempt can hit two phones — count days, not rows).
    // Only the opening line changes; the approved body stays verbatim.
    let msgTemplate = tmpl.message;
    if (d.kind === "ema_enable") {
      const priorDates = new Set(sentLog.filter(e =>
        e.kind === "ema_enable" && e.status === "sent" && !e.dryRun &&
        e.pid === d.pid && String(e.instrument || "").includes(`Y${d.wave}`)
      ).map(e => String(e.timestamp).slice(0, 10)));
      const FIRST_LINE = "Hi [preenrollment_arm_1][first_name]! This is the the study Team.";
      const OPENERS = [
        null, // attempt 1: template as written
        "Hi [preenrollment_arm_1][first_name]! It's the the study Team again — just a reminder in case you missed our last text.",
        "Hi [preenrollment_arm_1][first_name]! It's the the study Team — we haven't heard from you yet, so here's one more reminder.",
        "Hi [preenrollment_arm_1][first_name]! It's the the study Team with one more reminder about our social check.",
      ];
      const opener = OPENERS[Math.min(priorDates.size, 3)];
      if (opener && msgTemplate.startsWith(FIRST_LINE)) msgTemplate = opener + msgTemplate.slice(FIRST_LINE.length);
    }
    const body = renderMessage(msgTemplate, p, surveyLinks, d.expireDate);

    // Never send a message with an unresolved link — a participant must
    // not receive "[SURVEY LINK PENDING]". Log for coordinator follow-up.
    if (body.includes("[SURVEY LINK PENDING]")) {
      skipped++;
      sentLog.push({
        id: dueKey(d), sendKey: `${dueKey(d)}|none|unresolved-link`,
        timestamp: new Date().toISOString(),
        pid: d.pid, alertId: d.alertId, instrument: tmpl.instrument,
        channel: "none", recipient: "-", status: "skipped",
        error: "survey link unresolved — message NOT sent",
      });
      console.warn(`  ⚠ ${d.pid} alert ${d.alertId}: survey link unresolved — SKIPPED (not sent)`);
      continue;
    }

    const ch = KIND_CHANNELS[d.kind] || { sms: false, email: false };
    const phones = [p.contact.phonePrimary, p.contact.phoneSecondary].filter(Boolean);
    const email = p.contact.email;

    const attempt = async (channel, recipient, fn) => {
      const sk = sendKey(d, channel, recipient);
      if (doneKeys.has(sk)) return; // already sent this exact message
      try {
        await fn();
        sent++;
        doneKeys.add(sk);
        sentLog.push({
          id: dueKey(d), sendKey: sk, timestamp: new Date().toISOString(),
          pid: d.pid, alertId: d.alertId, instrument: tmpl.instrument, kind: d.kind,
          channel, recipient, status: "sent", dryRun: DRY_RUN || undefined,
        });
        console.log(`  ✓ ${channel} → PID ${d.pid} (${recipient}) [${tmpl.instrument}]`);
      } catch (err) {
        failed++;
        sentLog.push({
          id: dueKey(d), sendKey: sk, timestamp: new Date().toISOString(),
          pid: d.pid, alertId: d.alertId, instrument: tmpl.instrument, kind: d.kind,
          channel, recipient, status: "failed", error: err.message || String(err),
        });
        console.error(`  ✗ ${channel} → PID ${d.pid} (${recipient}): ${err.message}`);
      }
    };

    if (ch.sms) for (const ph of phones) await attempt("sms", ph, () => sendSMS(ph, body));
    // No email creds in this environment (e.g. local outage-fallback run):
    // skip silently — the ledger has no 'sent' row for the email channel,
    // so the next CI run with full creds catches the emails up.
    if (ch.email && email && GMAIL_USER) await attempt("email", email, () => sendEmail(email, emailSubject(d.kind), body));

    writeJson(SENT_LOG_PATH, sentLog); // snapshot so a crash loses nothing
  }

  writeJson(SENT_LOG_PATH, sentLog);
  writeJson(STATE_PATH, { lastRunAt: new Date(now).toISOString(), dryRun: DRY_RUN });
  console.log(`\nDone. sent=${sent} failed=${failed} skipped=${skipped} (dryRun=${DRY_RUN})`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
