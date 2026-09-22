---
sidebar_position: 6
title: Data model
description: Reference for every JSON file TEMPO reads and writes, who produces it, who consumes it, and what each field means.
---

TEMPO has no database. Its entire state is a directory of JSON files that a
fetch job regenerates, senders append to, and the dashboard reads. Every script
resolves the same constant:

```js
// scripts/fetch-data.mjs, send-due-messages.mjs, send-ema-prompts.mjs, daily-audit.mjs
const DATA_DIR = path.join(__dirname, "..", "private", "data");
```

`private/` is gitignored here, and this repository ships only synthetic examples
under `examples/fixtures/`. In a deployment, these files live in whatever
access-controlled store you choose. The reference implementation keeps them in a
repository reached through a scoped token, which is why the serverless components
address them by path (`LEDGER_REPO_PATH` in `src/app/api/ema-sweep/route.ts`,
`DATA_DIR_REPO` in `src/app/api/refresh/route.ts`, the `git show` in
`scripts/merge-ledgers.mjs`) — swap those accessors to point at your store.

## At a glance

| File | Produced by | Consumed by |
|---|---|---|
| `participants.json` | `scripts/fetch-data.mjs` | dashboard, both senders, audit |
| `due-reminders.json` | `scripts/fetch-data.mjs` | dashboard only |
| `send-candidates.json` | `scripts/fetch-data.mjs` | `send-due-messages.mjs`, audit |
| `ema-prompt-schedule.json` | `scripts/fetch-data.mjs` | `send-ema-prompts.mjs`, `/api/ema-sweep`, audit |
| `sent-log.json` | `send-due-messages.mjs` | fetch (payment gating), dashboard, audit |
| `ema-sent-log.json` | `send-ema-prompts.mjs`, `/api/ema-sweep` | fetch (anchor guard), dashboard, audit |
| `opt-outs.json` | hand-edited | fetch, `send-due-messages.mjs` |
| `postponed.json` | hand-edited | `send-due-messages.mjs`, audit |
| `last-fetch.json` | `scripts/fetch-data.mjs` | dashboard, audit |

## participants.json

The roster snapshot: one pivoted object per participant, rewritten in full on
every fetch. Written at `fetch-data.mjs:1757` as
`{ participants: [...], fetchedAt }` — a wrapper, not a bare array, so the API
routes and senders all reach for `.participants`.

```json
{
  "fetchedAt": "2026-01-15T14:00:00.000Z",
  "participants": [
    { "pid": "1001", "recordId": "1001", "contact": { }, "activeWave": 1, "waves": { "1": { } } }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `pid` | string | Coordinator-facing ID. Currently `String(recordId)`. |
| `recordId` | string | Survey-database record ID, used for every API call. |
| `contact` | object | Constant per participant; see below. |
| `waves` | `{ "1"\|"2"\|"3": WaveStatus }` | Only waves with at least one event row appear. |
| `activeWave` | 1\|2\|3\|null | Highest wave with a V1 and an unfinished V2; `null` once all waves close. |

`contact` carries `firstName`, `lastName`, `parentName`, `email`,
`phonePrimary`, `phoneSecondary`, `childPhone`, `cohortGroup`, `dob` and a
computed `age` (`fetch-data.mjs:380`). `age` is load-bearing: under 13
suppresses the EMA enable nudge.

Each wave (`fetch-data.mjs:506`) holds six slots, any of which can be `null`
when that event has no row yet:

| Slot | Shape | Notes |
|---|---|---|
| `v1`, `v2` | `{ date, forms: {name: 0\|1\|2}, allComplete }` | `forms` is every `*_complete` code with the suffix stripped. `allComplete` is the **last defined** `break_N_complete === 2`, falling back to "any form complete". |
| `atHome` | `{ timestamp, break1Complete, athomeMeasuresComplete }` | `timestamp` and `break1Complete` are read off the **visit** row, not the at-home row — they do not exist on the at-home event until the participant starts it. |
| `sts1`, `sts2` | `{ active, cycles: [{ index, date, complete, surveyLink }] }` | Six cycles for STS1, three for STS2. `complete` is the survey-platform code `0`/`1`/`2`. |
| `ema` | see below | |

`ema` is the richest slot (`fetch-data.mjs:466`): `active` (true once the enable
field is set to anything non-empty and non-`"0"`), `startDay`, `startDayCalc`,
`settingsComplete`, `paymentComplete`, `paymentRedeemed`, `phone` (the line the
participant chose for prompts, falling back to `phonePrimary`), and `prompts`:
25 entries of `{ key, dayLabel, timeLabel, scheduledAt, complete }` on the fixed
grid defined by the `EMA_PROMPTS` table at `fetch-data.mjs:59`.

## due-reminders.json vs send-candidates.json

Both are written from the same array in one place (`fetch-data.mjs:1763`):

```js
const displayQueue = due.filter(d => d.scheduledAt >= nowIso);
fs.writeFileSync(path.join(DATA_DIR, "due-reminders.json"), JSON.stringify(displayQueue, null, 2));
fs.writeFileSync(path.join(DATA_DIR, "send-candidates.json"), JSON.stringify(due, null, 2));
```

`due-reminders.json` is **strictly future-only** — the dashboard's
scheduled-only rule, so the Reminders page never shows a send in the past.
`send-candidates.json` additionally keeps items whose time passed within the
last 24 hours (`sendFloor` at `fetch-data.mjs:645`).

:::danger This distinction caused a real outage
A "due" item is by definition just-past. When the sender read the future-only
display queue, every fetch pruned items seconds before the send step could fire
them. Per the comment at `fetch-data.mjs:638`, that is "exactly what silently
starved the sender of the entire July 2026 cycle." The sender therefore prefers
candidates and only falls back to the display queue:
`readJson(CANDIDATES_PATH, null) ?? readJson(DUE_PATH, [])`
(`send-due-messages.mjs:286`). Do not conflate the two files.
:::

Row shape (identical in both files):

| Field | Type | Meaning |
|---|---|---|
| `pid`, `recordId`, `wave` | string / string / 1-3 | Who and which wave. |
| `alertId` | number | Timeline spec alert number; selects the template. |
| `kind` | string | `sts1_invite`, `sts1_followup`, `sts2_invite`, `sts2_followup`, `athome_sms`, `athome_email`, `ema_enable`, `payment_email`, `payment_followup`, `payment_expire`. Maps to channels via `KIND_CHANNELS` (`send-due-messages.mjs:245`). |
| `instrument` | string | Human label shown on the dashboard and stored in the ledger. |
| `scheduledAt` | ISO string | When it should fire. The sender's window is `(windowStart, now]`. |
| `complete` | boolean | Always `false` at write time; a completed survey simply never queues. |
| `surveyLink` | string \| null | Pre-resolved link, back-filled at `fetch-data.mjs:1749`. |
| `expireDate` | ISO string | Payment family only — renders `[expire_date]`. |
| `hypotheticalStartDay`, `wouldTriggerPrompts` | string, array | `ema_enable` only: the Monday being nudged toward and the 25 prompts that would fire. Display payload. |
| `mode` | `"auto"` \| `"manual"` | The sender skips `manual` rows (`send-due-messages.mjs:341`). The current generator never emits it; it exists for hand-staged rows. |

## sent-log.json

Append-only ledger for the general sender, one row per (message, channel,
recipient). It is the idempotency mechanism: `doneKeys` is built from it at
`send-due-messages.mjs:331` and a matching `sendKey` suppresses a resend.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `pid\|alertId\|scheduledAt` — identifies the message. |
| `sendKey` | string | `id\|channel\|recipient` — identifies the delivery. The dedup key. |
| `timestamp` | ISO string | When the attempt happened. |
| `pid`, `alertId`, `instrument`, `kind` | — | Copied from the queue row. |
| `channel` | `sms` \| `email` \| `none` | `none` on link-skip rows. |
| `recipient` | string | Phone or email as sent; `"-"` on skips. |
| `status` | `sent` \| `failed` \| `skipped` | See below. |
| `error` | string | Present on `failed` and `skipped`. |
| `dryRun` | true \| absent | Set when `DRY_RUN` was on. |

`sent` means the provider accepted it. `failed` means three attempts with
transient-error backoff all lost; the item stays eligible next run. `skipped`
means the message was deliberately not transmitted — in practice an unresolved
survey link, because a participant must never receive the literal text
`[SURVEY LINK PENDING]` (`send-due-messages.mjs:434`).

:::warning Dry-run rows must never satisfy "already sent"
`doneKeys` filters `status === "sent" && !e.dryRun`. A rehearsal that counted as
a delivery would let a real recovery silently no-op against its own dry run.
:::

## ema-sent-log.json

The prompt ledger, written by two independent senders: the long-lived segment
job (`scripts/send-ema-prompts.mjs`) and the Vercel minute-cron route
(`src/app/api/ema-sweep/route.ts`). Row identity is
`key = pid|wave|promptKey`; other fields are `pid`, `wave`, `promptKey`,
`channel`, `recipient`, `sendAt` (the scheduled slot), `at` (when this row was
written), `latencySec`, `note` (which leg wrote it), `error`, `dryRun`.

| `status` | Meaning |
|---|---|
| `sent` | Transmitted. `latencySec` records seconds after the slot — the precision metric the audit reports. |
| `failed` | Provider call failed. **Not terminal**: retried every tick until the grace window closes. |
| `skipped` | Unusable row — bad phone or missing survey link. Terminal, so the audit sees it instead of an infinite retry. |
| `skipped_late` | More than 30 minutes past the slot. The EMA protocol itself says skip; sending a stale momentary prompt is a protocol violation, not a rescue. |
| `already_delivered` | The provider's own message history already shows this prompt going to this number. Written when a leg stands down because another leg got there first. |
| `sending` | A **claim**, not an outcome. Written by the sweeper before an exact-second fire so only one concurrent invocation owns the slot. A claim younger than `CLAIM_FRESH_MS` (120s) blocks others; older means the claimant died and the prompt is rescuable. Claims are swept when the outcome row lands. |

Terminal statuses are `sent`, `skipped_late`, `skipped`, `already_delivered`.
`sending` and `failed` are not.

:::warning Ledgers are union-merged, never overwritten
`scripts/merge-ledgers.mjs` unions each ledger with `origin/main` before the
commit step. The pipeline's `-X theirs` rebase is right for regenerated files
and catastrophic for append-only ones — per the script's header, that is how the
2026-08-09 double-send happened: a run on a stale snapshot re-sent 74 messages,
then its commit erased the first run's 74 rows.
:::

## ema-prompt-schedule.json

The materialized send plan, sorted by `sendAt` (`fetch-data.mjs:1664`). Each row
is one prompt: `pid`, `recordId`, `wave`, `key`, `reportNum`, `dayLabel`,
`timeLabel`, `sendAt` (exact ISO instant), `phone` (the participant's chosen EMA
line), and `surveyLink` **pre-resolved at fetch time**. That last point is the
design: the precision sender needs no survey-database access at fire time, so a
slow or down API cannot make a 7:34 AM prompt late.

Rows are only emitted for participants whose cycle is active, who are not opted
out, and who pass `emaEligibleCohort(pid)`. Prompts already complete, or more
than 24 hours past, are omitted.

## opt-outs.json, postponed.json, last-fetch.json

`opt-outs.json` is an object keyed by record ID; keys beginning with `_` are
ignored, which is how the `_readme` key lives in the file. **Only the keys are
read** — `reason`, `date` and `channels` are documentation for humans, not
behavior. Enforcement is deliberately doubled: the queue generator excludes
these PIDs (`fetch-data.mjs:655`), the EMA schedule excludes them
(`fetch-data.mjs:1599`), and the sender re-checks at send time, because a stale
candidates file must never be trusted with someone's opt-out
(`send-due-messages.mjs:292`).

`postponed.json` is a flat array of PID strings, compared lowercased. Postponed
participants are skipped by the sender and bucketed separately by the audit.
Note a real wart: the dashboard has its own hardcoded `POSTPONED_SUBIDS` set in
`src/lib/postponed.ts`, which is not kept in sync with the file.

`last-fetch.json` is the freshness stamp and run metrics, written on success at
`fetch-data.mjs:1768` and, with `ok: false` plus `error`, from the fatal handler
at `fetch-data.mjs:1797`.

| Field | Meaning |
|---|---|
| `ok` | Whether the fetch succeeded. |
| `timestamp` | ISO time of the run. The audit flags staleness past 120 min (540 min before 9 AM ET, when the survey database is routinely down overnight). |
| `staleEmaAnchors` | Enabled EMA waves whose schedule was withheld pending a human re-anchor. |
| `sheetId` | The spreadsheet the pipeline read, surfaced so the dashboard embeds exactly that workbook. |
| `counts` | `{ participants, dueNext7Days }`. |
| `metrics` | `{ redcapRows, participants, reportRowCounts }` — the baseline for the next run's silent-dropout floor checks. |

## Supporting state files

| File | Shape | Role |
|---|---|---|
| `send-state.json` | `{ lastRunAt, dryRun }` | Anchors the sender's catch-up window. Absent means first run: forward-only, no backlog blast. Deliberately **not** advanced during quiet hours. |
| `recovery-sends.json` | Array of queue rows | Coordinator-approved catch-up sends, time-gated like normal items; `RECOVERY=true` bypasses the gate. Safe to leave staged. |
| `ema-anchor-overrides.json` | `{ "pid\|wave": "YYYY-MM-DD" }` | Rolled EMA start Mondays, persisted so an anchor can never slide once prompts have gone out. |
| `audits/YYYY-MM-DD.json` | Report object | One daily reconciliation from `scripts/daily-audit.mjs`. |
| `audits/index.json` | Array of `{ date, verdict, problems, warnings, generatedAt }` | Index behind the Daily Audit tab. |
| `local-timer-heartbeat.json` | `{ at, leg }` | Heartbeat from the independent backstop machine; silence past 26 hours is an audit warning. |
| `refresh-shadow-verdicts.json` | Array of verdicts | Durable parity record for the shadow refresh path. |

## Where these files belong

:::danger These files contain identifiable participant data
These files carry contact details and personal survey links: the ledgers record
who was messaged, at which endpoint, and when, and anyone holding a personal
survey link can open that participant's survey.

Two consequences worth designing around. First, **pull only what you need** —
the snapshot contains whatever fields your pipeline selects, and delivery
requires just a record identifier and a contact endpoint. Names, dates of birth
and other identifiers are optional; if the dashboard does not display them, do
not fetch them. Second, **put the store behind authentication** and keep it out
of anything you publish or build artifacts you distribute. See `SECURITY.md`.
:::
