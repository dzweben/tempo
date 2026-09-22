---
sidebar_position: 5
title: Delivery and safety rails
description: How TEMPO fires messages at the exact second, and the layered rails that make double-sends, late sends, and mass blasts structurally hard.
---

Sending is the part of TEMPO that cannot be rolled back. A survey row can be corrected; a 3 a.m. text to a fifteen-year-old cannot be unsent, and neither can the second copy of a prompt that already arrived. Every rail on this page exists because something went wrong in production first: a scheduler that fired hours late, a rebase that erased a ledger and caused 74 duplicate messages, a prompt sender that went quietly dead and was not noticed for two weeks.

TEMPO has two senders with different jobs and different clocks.

| Sender | File | Cadence | Precision requirement |
| --- | --- | --- | --- |
| EMA prompts | `src/app/api/ema-sweep/route.ts` | serverless cron, every 60 s (`vercel.json`) | to the second |
| Everything else | `scripts/send-due-messages.mjs` | inside the CI refresh pipeline | to the half-hour |

## The exact-second sender

A momentary-assessment prompt scheduled for 7:34 a.m. means 7:34 a.m. No cron scheduler — GitHub's or Vercel's — promises that. The route's answer is to stop asking the scheduler for precision and take it in-process.

`tick()` classifies every eligible schedule row against three windows:

```ts
const GRACE_MS = 30 * 60 * 1000;   // protocol: past this, skip, don't send
const LOOKAHEAD_MS = 75_000;       // slots this close are WAITED FOR in-process
const CLAIM_FRESH_MS = 120_000;    // a "sending" row this young is a live claim
```

- **`due`** — the slot has passed but is within the 30-minute grace. Send now.
- **`expired`** — past grace, within 24 h. Write a `skipped_late` ledger row. The EMA protocol itself says a prompt more than 30 minutes late is a skip, so the honest outcome is a recorded non-send, not a wrong-time send.
- **`upcoming`** — the slot is inside the next 75 seconds. The invocation groups these by slot time, `await sleep(waitMs)` until the exact millisecond, and fires. Precision comes from inside the process; the scheduler only has to be roughly punctual.

`LOOKAHEAD_MS` is deliberately just above the 60-second invocation cadence. That guarantees at most about two invocations are ever awake waiting on the same slot — a bounded contention problem instead of an unbounded one.

:::note
`maxDuration = 300` caps the function at five minutes, so the loop breaks on any slot beyond `now + 280_000`. Slots further out are simply picked up by a later tick.
:::

### Resolving concurrent invocations to exactly one send

Two invocations waiting on the same slot must produce one message. The route resolves this with a compare-and-swap on the ledger file itself. Before firing, it re-reads `app/private/data/ema-sent-log.json` with its blob SHA, appends `status: "sending"` claim rows for the keys it intends to fire, and PUTs the file back with that SHA. The GitHub contents API rejects a PUT whose SHA is stale, so of the invocations racing for a slot exactly one wins the write. The losers re-read (the loop runs up to twice), see the fresh claim, and drop the keys.

A claim is only honored while it is young. `claimFresh()` treats a `sending` row older than `CLAIM_FRESH_MS` (two minutes) as abandoned — the claimant crashed — which makes the prompt rescuable again rather than permanently poisoned by a dead process.

### Asking the carrier

The ledger only knows what TEMPO wrote to it. It cannot know about a message sent by a different process, an older sender, or a run whose ledger write failed. So before each send, `alreadyDelivered()` queries the messaging provider's own message history for outbound messages to that participant since the slot opened, and looks for one containing this prompt's survey link:

```ts
const createdAfter = new Date(sendAtMs - 2 * 60 * 1000).toISOString();
// ... for each returned message:
if (dir !== "incoming" && link && text.includes(link)) return true;
```

The carrier is the one party that observes every sender. That makes its history the arbiter across senders past and present — including the retired GitHub-based prompt sender in `scripts/send-ema-prompts.mjs`, which performs the same check (`carrierHasDelivered()`) on any send more than two minutes late.

### Fail open or fail closed

When the history check itself errors, TEMPO has to choose which failure it prefers. The route chooses based on whether its own ledger read was live:

```ts
const delivered = await alreadyDelivered(apiKey, pnId, phone, link, sendAtMs);
if (delivered === null && !ledgerSha) { report.unverifiable++; return; }
```

With a live ledger in hand (`ledgerSha` set), the route is the protocol-authoritative primary inside the grace window: it **fails open and sends**, because a lost prompt is a certain protocol violation while a double-send requires the vanishing coincidence of another sender having delivered *and* the history API being down at that instant. Without a live ledger — running off the bundled fallback copy, which may be stale — it **fails closed** and retries next tick. The same doctrine governs the claim step: if GitHub is unreachable at fire time, `resolved` stays false and the route fires anyway rather than losing the slot.

### Warm-instance memory

```ts
const sentThisInstance = new Set<string>();
```

A module-level set, checked in `fireRow()` alongside the ledger. If a serverless instance is reused across ticks and both GitHub and the carrier are unreachable in the same minute, this is the last thing standing between a retry and a duplicate. It is not a substitute for the other rails — a cold instance starts empty — which is exactly why it is a third belt and not the design.

### Degradation, not silence

Schedule and opt-out registry are read live from the data repository, with the deployed bundle as fallback (`source: "github-live" | "bundle-fallback"`). An API blip degrades TEMPO to yesterday's data, not to silence. Two eligibility rules are enforced unconditionally regardless of what the schedule file says: participants in the 1000–1999 range never receive EMA texts, and anyone in `opt-outs.json` never receives anything.

Status semantics matter here. `sent`, `skipped_late`, `skipped`, and `already_delivered` are terminal. `failed` is **not** — a transient carrier error leaves the prompt retryable on every subsequent tick until grace runs out. Bad data (unparseable phone, missing link) *is* terminal, recorded as `skipped` so the audit sees it instead of watching a row retry silently once a minute.

Every tick logs its `trigger` and what it saw. That attribution was missing during the 2026-09-18 dead-clock post-mortem, which is why it is unconditional now.

## The batch sender

`scripts/send-due-messages.mjs` runs inside the refresh pipeline — fetch, then send — so every send decision is made against completion data pulled minutes earlier. That ordering *is* the completion re-check: a reminder only exists in the queue if its survey was still incomplete as of that fetch.

Its window model assumes the scheduler is unreliable:

```js
const CATCHUP_MS = 18 * 3600 * 1000;   // never send anything older than 18h
const OVERLAP_MS = 5 * 60 * 1000;      // re-examine 5 min before lastRun
windowStart = Math.max(last - OVERLAP_MS, now - CATCHUP_MS);
```

Everything with `scheduledAt` in `(windowStart, now]` fires. The five-minute overlap deliberately re-examines already-processed items and lets the ledger absorb the duplicates — a tight window would silently drop sends whenever a CI run was delayed. With no `send-state.json` at all, `windowStart = now`: a first run is forward-only, so standing up TEMPO never blasts a backlog.

The remaining rails, in the order they execute:

- **Quiet hours.** `inQuietHours()` blocks sends before 8:00 a.m. or after 9:30 p.m. Eastern. Critically, the early return does **not** advance `lastRunAt`, so blocked items remain inside the next run's window instead of falling off the edge. A dry run continues through quiet hours, since a run that transmits nothing has nothing to be quiet about.
- **Opt-outs and pauses.** `opt-outs.json` and `postponed.json` are re-checked at send time even though the queue generator already applied them — a stale candidates file must never be trusted with someone's opt-out.
- **Unresolved-link refusal.** Personal survey links are resolved just-in-time from the survey database. If rendering still contains `[SURVEY LINK PENDING]`, the message is **not sent**; a `skipped` ledger row with `sendKey: ...|none|unresolved-link` is written for coordinator follow-up.
- **Per-run cap.** `estMessages` counts *channel* sends (a reminder can be two SMS plus an email) and throws before any transmission if it exceeds `MAX_SENDS_PER_RUN` (default 1500). A queue-generation bug aborts the run loudly instead of blasting the roster.
- **Ledger dedup.** `sendKey(d, channel, recipient)` is `pid|alertId|scheduledAt|channel|recipient` — the finest useful grain, so a retry to a second phone number is not confused with a duplicate to the first. The log is written after *every* reminder, not once at the end, so a crash loses nothing.
- **Dry-run isolation.** `DRY_RUN` defaults to *true*; only an explicit `"false"` transmits, and the CI kill switch (`SEND_LIVE`) flips it without a redeploy. Dry-run rows are excluded from `doneKeys` via `!e.dryRun`. A rehearsal must never satisfy "already sent" — the July recovery would otherwise have silently no-op'd against its own dry run.

## Why ledgers are never overwritten

`scripts/merge-ledgers.mjs` runs immediately before `git add` in the commit step. It fetches `origin/main`'s copy of each ledger and unions it with the local copy using a per-file identity function:

```js
const LEDGERS = [
  ["sent-log.json", (e) => e.sendKey || `${e.id}|${e.channel}|${e.recipient}|${e.timestamp}`],
  ["ema-sent-log.json", (e) => `${e.key}|${e.status}|${e.dryRun ? "dry" : "real"}|${e.at || ""}`],
];
```

:::danger The 2026-08-09 double-send
The refresh pipeline rebases with `-X theirs`, which is correct for regenerated files — participants, queues, schedules — where the freshest fetch should win. It is catastrophic for append-only ledgers: on conflict it replaces the file wholesale. A dispatched run working from a stale snapshot re-sent 74 messages, and its commit then erased the first run's 74 rows, destroying the evidence along with the idempotency. Union-merging *before* committing means the committed file already contains every row both sides know about, so whatever the rebase does afterwards is harmless.
:::

## The rails, summarized

Three independent at-most-once mechanisms are not redundancy — each catches what the others structurally cannot.

| Rail | What it prevents | Where it lives |
| --- | --- | --- |
| Terminal-state ledger dedup | Re-sending something a completed run already finished | `TERMINAL` / `done` in `route.ts`; `doneKeys` in `send-due-messages.mjs` |
| Claim via compare-and-swap | Two live invocations both firing the same slot | `ghPutJson` claim + `claimFresh()`, `CLAIM_FRESH_MS` |
| Carrier-history arbitration | A send by *another* sender, or one whose ledger write failed | `alreadyDelivered()`; `carrierHasDelivered()` in `send-ema-prompts.mjs` |
| Warm-instance memory | A duplicate when ledger *and* carrier are both unreachable | `sentThisInstance` |
| Grace period | A prompt arriving at a protocol-invalid time | `GRACE_MS`, `skipped_late` rows |
| Quiet hours | Overnight messages | `inQuietHours()` |
| Catch-up horizon | A backlog blast after an outage | `CATCHUP_MS` |
| Per-run cap | A queue bug mass-messaging the roster | `MAX_SENDS_PER_RUN` |
| Link guard | Sending a message with a broken survey link | `body.includes("[SURVEY LINK PENDING]")` |
| Dry-run isolation | A rehearsal suppressing the real send | `!e.dryRun` filters in both senders |
| Union merge | A rebase erasing another run's ledger rows | `merge-ledgers.mjs` |

The ledger is blind to other processes. The claim is blind to anything that already happened before this tick. The carrier check is blind whenever its API is down. Remove any one and a real, observed failure mode reopens.

## Known limitations

Read these before adapting TEMPO.

- **Time zone and quiet hours are compile-time constants.** `America/New_York` is hardcoded in `easternParts()` (`send-due-messages.mjs`), `etMinutes()` (`send-ema-prompts.mjs`), and `daily-audit.mjs`; the 8:00 a.m.–9:30 p.m. bounds are literals in `inQuietHours()`. There is no per-participant or per-study time zone. A multi-site study spanning time zones needs real work here, not a config change.
- **The catch-up horizon drops messages by design.** An outage longer than `CATCHUP_MS` (18 h) means those messages are never sent. That is a protocol-correct choice: a survey prompt arriving 20 hours late is worse than one that never arrives, and the daily audit surfaces the gap the next morning.
- **Eligibility arithmetic is study-specific.** The `1000–1999` cohort exclusion is a literal in both EMA senders. `stsStillIncomplete()` maps alert ID ranges (48–53, 54–59, 89–91, 93–95) to survey cycles. These are your study's numbers to replace, not general logic.
- **The data repository is hardcoded in the route.** `route.ts` declares `const REPO = "YOUR-GITHUB-ORG/YOUR-DATA-REPO"` and `LEDGER_REPO_PATH` as module constants rather than reading `GITHUB_REPOSITORY` from the environment, even though `.env.example` defines it. Edit the file.
- **Message templates are extracted by regex.** Both EMA senders locate the prompt body with `/alertId: 64,[\s\S]*?message: (...)/ ` against `src/lib/timeline.ts`, and `loadTimeline()` parses the whole spec with one block regex that throws on zero matches. Reformatting `timeline.ts` can break sending. The route degrades honestly — it logs a loud error and sends nothing rather than sending an empty message — but this is the most brittle seam in the system.
