---
sidebar_position: 8
title: Adapting TEMPO to your study
description: An honest, file-by-file porting guide for running TEMPO against your own protocol, database and messaging accounts.
---

TEMPO is a reference implementation plus a reusable delivery engine. It is not multi-tenant software, and there is no `study.config.json` that makes it yours. Porting it means forking the repository and editing perhaps six files, one of which — `scripts/fetch-data.mjs`, around 1,800 lines — encodes one study's database schema and enrollment arithmetic in full.

The good news: the hard part, the part that took production incidents to get right, is the part you do not touch. The delivery rails, ledgers, link guards, audit and auth are protocol-agnostic. What you rewrite is the study-specific layer sitting on top of them.

:::warning
If your study cannot spare a research software engineer for a week inside a scheduling script, TEMPO is the wrong tool.
:::

## The order of work

| # | What | Where |
|---|---|---|
| 1 | Your messages | `src/lib/timeline.ts` |
| 2 | Your database's event and field names | `scripts/fetch-data.mjs` |
| 3 | Eligibility and schedule arithmetic | `scripts/fetch-data.mjs`, `src/lib/cohort.tsx` |
| 4 | Coordinator spreadsheet merge (optional) | `scripts/fetch-data.mjs` |
| 5 | Environment and deployment | `.env.example`, `vercel.json`, `examples/workflows/` |
| 6 | Time zone and quiet hours | senders, `src/lib/tempo-utils.ts` |

## 1. The timeline spec

`src/lib/timeline.ts` is the primary configuration surface: one object per automated message, carrying `condition`, `sendDateSpec`, `destinationSpec`, `emaKey` and the `message` template. The shipped `RAW` array is a synthetic example for a fictional study — ten entries demonstrating each supported kind. Replace it wholesale.

Three mechanical constraints are easy to miss:

- **The file is parsed, not imported, by the senders.** `loadTimeline()` in `scripts/send-due-messages.mjs` (line 218) runs a regular expression over the TypeScript source expecting the exact field order `alertId, wave, kind, instrument, … message`, terminated by `},`. It throws `Parsed 0 timeline entries` if you restructure the object. The EMA path is narrower still: `promptTemplate()` in `scripts/send-ema-prompts.mjs` and in `src/app/api/ema-sweep/route.ts` greps specifically for `alertId: 64` to find the prompt body.
- **Channel routing is declared twice.** `parseChannels()` derives channels from `destinationSpec`, but the sender uses its own `KIND_CHANNELS` map (`scripts/send-due-messages.mjs:245`). A new `kind` that is missing from that map resolves to `{ sms: false, email: false }` and sends nothing, silently. Email subject lines live beside it in `emailSubject()`.
- **Merge fields are a fixed list.** `renderMessage()` substitutes a hardcoded table of placeholders keyed to one study's event names (`[preenrollment_arm_1][first_name]` and friends, line 108), plus the generic `[survey-link:instrument]` pattern. Note that the example spec writes `[enrollment_arm_1][first_name]`, which that table does not contain — so the shipped example would render an empty name. Bring the two into agreement for your own field names, and mirror the change in `renderMessageTemplate()` in `src/lib/tempo-utils.ts`, which the dashboard uses to preview messages.

## 2. Field bindings

`scripts/fetch-data.mjs` is the one file that knows your survey database. Work through it in this order.

**Event names.** `eventName(kind, wave)` (line 41) maps a logical kind to a literal event slug: `visit_1_y${wave}_arm_1`, `ema_y${wave}_arm_1`, and so on. Everything downstream — the fetch loop, link resolution, the sender's `remapEventForWave()` — addresses events through this function. Rewrite it first.

**The export loop.** `fetchAllRecordsStreaming()` (line 148) fetches one event at a time and streams rows straight into a per-record bucket. This is deliberate: a single bulk export was large enough to exhaust the REDCap server's memory. `redcapPost()` retries transient failures and 5xx responses with exponential backoff, because the institution's REDCap returns 500s under load and recovers within seconds. Keep both behaviors; change only the event list.

**Completion reports.** Per-wave saved-report IDs drive survey-status truth. `.env.example` documents `COMPLETION_REPORT_IDS` as a JSON map, but in the current source `main()` still carries a literal `COMPLETION_REPORTS` object (line 1180) with one study's numeric IDs. Check which your checkout has, and either wire the env var through or edit the map. A report failure is deliberately fatal: swallowing it would reset a whole wave to "incomplete" and deploy that as fresh.

**The pivot.** `pivotParticipant()` (line 360) turns a record's event rows into a participant object. It returns `null` unless an enrollment row exists (a pre-enrollment row alone is a signup form, roughly three times as numerous), reads contact fields via `pick()` with enrollment-then-pre-enrollment fallback, and builds per-wave `v1 / atHome / sts1 / sts2 / ema / v2` sub-objects. Visit completion uses the last defined `break_*_complete` checkpoint. Every one of those field names is yours to replace.

**Survey links.** Personal links are resolved from the database, never constructed. `fetchSurveyLink()` wraps the `surveyLink` API; `linkSpec()` (line 1692) maps each queued item's `kind` and `alertId` back to an `(event, instrument)` pair; `batchAsync()` caps concurrency at three with a 200 ms pause. `linkSpec()` is arithmetic over this study's alert IDs (`alertId - 48`, `alertId - 89`) and must be rewritten alongside your spec.

## 3. Eligibility and schedule arithmetic

:::danger
This is the section people underestimate. The example carries one study's enrollment arithmetic end to end, and none of it is parameterized.
:::

Concretely, the following are study-specific rules, not features:

- **Cohorts are PID ranges.** `cohortOfPid()` in `src/lib/cohort.tsx` maps 1000–1999, 2000–2999 and 3000–3999 to cohorts 1–3; `main()` drops any record outside 1000–3999 as test residue (line 1166).
- **Hard cohort exclusion.** `emaEligibleCohort()` (line 231) refuses momentary-assessment delivery to PIDs 1000–1999 regardless of age. The same rule is re-asserted inline in `scripts/send-ema-prompts.mjs:202`.
- **An age gate.** Participants under 13 (computed from date of birth) are excluded from EMA scheduling and from the EMA columns in `computeStats()`.
- **Anchor chains.** `computeStsCycleDates()` fires cycles at 17:00 on day 20 of the month following an anchor; the STS1 anchor is the wave's V2, and the STS2 and EMA anchors are derived from STS1 cycle 6 plus four and five months. `STS_DAY_OVERRIDES` (line 266) even carries a one-month slip for a specific calendar month.
- **Prompt grids.** `EMA_PROMPTS` (line 59) lists 25 field/day/time triples, expanded against a Monday start by `EMA_DAY_OFFSET` and `computeEmaPromptDates()`. The enable nudge fires 3 days 8 hours before the start day and rolls forward weekly up to four weeks.
- **Gate-in.** Participants without a completed Wave 1 V1 are dropped entirely (line 1499), except record IDs listed in `TEST_PIDS`.
- **Completion thresholds.** `src/lib/tempo-utils.ts:89` defines "done" as 7 of 8 at-home sections, 5 of 9 screen-time surveys, 10 of 25 prompts.

Budget real time here, and treat `computeDueReminders()` (line 610) as something you rewrite rather than tune.

## 4. The coordinator spreadsheet (optional)

Some studies keep visit dates in a spreadsheet rather than the database. `fetchFollowupSheet()` (line 1063) authenticates a Google service account by signing a JWT with Node's `crypto` (no SDK), reads three cohort tabs, and pulls V1/V2 dates by column letter from `COHORT_TABS` (line 1032). It is fatal-when-configured-but-failing: a silent `{}` would wipe every visit date and empty the queue.

To drop it, leave `GOOGLE_SERVICE_ACCOUNT_JSON` unset — the function returns `{}` and logs a skip.

:::warning
Dropping the sheet is not free. A later pass (line 1360) sets `v1.allComplete` and `v2.allComplete` *strictly* from sheet presence, deliberately overriding the database's own completion codes. Remove the sheet without replacing that pass and every visit reads as incomplete, which gates off screen-time, payment and EMA scheduling.
:::

## 5. Environment and deployment

Copy `.env.example` to `.env.local`. It covers the survey API, the SMS provider, SMTP, dashboard auth, the private data repository, cron secrets, and behavior flags: `SEND_LIVE` (kill switch), `MAX_SENDS_PER_RUN` (default 1,500) and `REFRESH_MODE` (`shadow` diffs only; `live` writes back).

Two deployment details are not env-driven yet. `src/app/api/ema-sweep/route.ts` and `src/app/api/refresh/route.ts` each declare `const REPO = "YOUR-GITHUB-ORG/YOUR-DATA-REPO"` with data paths under `app/private/data`, and `scripts/merge-ledgers.mjs` reads `git show origin/main:app/private/data/...`. If your data repository has a different layout, those literals need editing.

`vercel.json` registers the minute cron for `/api/ema-sweep` and a twice-hourly `/api/refresh`, and raises the refresh function's memory and duration. `examples/workflows/` holds the production CI skeletons — deliberately not in `.github/workflows/`, because they assume an `app/` subdirectory and commit into a separate private data repository. Read them for the patterns: the run-time uptime gate, the serialized concurrency group, the ledger union before commit.

## 6. Time zone and quiet hours

Both are compile-time constants, in four places:

- `scripts/send-due-messages.mjs:77-89` — `America/New_York`, and the 8:00 a.m.–9:30 p.m. quiet-hours window. When quiet hours block a run, `lastRunAt` is deliberately not advanced, so nothing is lost.
- `scripts/send-ema-prompts.mjs:51` — the ET segment windows the long-lived prompt job claims authority over.
- `src/lib/tempo-utils.ts:19` and `scripts/daily-audit.mjs:30` — the display and audit time zone.
- `scripts/fetch-data.mjs:544` — `easternOffset()` approximates daylight saving by month boundaries. That is honest about its own imprecision and fine on a 60-day display horizon; a study outside US Eastern should replace it with a real time-zone conversion.

## What transfers unchanged

You are not signing up to rewrite any of this:

- **The sender's window model and rails** — catch-up horizon, five-minute overlap, per-run cap, opt-out and postpone checks at send time, and the guarantee that a message with an unresolved link is logged as skipped rather than sent.
- **Precision prompt delivery** — waiting inside the invocation to fire on the exact second, the 30-minute protocol grace, ledger claims, and OpenPhone carrier-history arbitration before any late or rescued send.
- **Ledgers and merge** — append-only logs keyed per message/channel/recipient, dry-run rows that never satisfy "already sent," and `merge-ledgers.mjs`'s union against origin (written after a rebase strategy erased 74 rows and caused a double-send).
- **Link resolution** — just-in-time fetch with caching, wave remapping, and the pending-link guard.
- **The audit engine** — `scripts/daily-audit.mjs` reconciles planned against actual and buckets everything, including "completed before its slot." Its `cycleComplete()` helper does carry this study's alert-ID ranges; expect to touch that one function.
- **Auth and the dashboard shell** — `src/lib/auth.ts` (HMAC-signed cookie, constant-time compare), `src/middleware.ts`, and the nav, filters and page scaffolding.

## Realistic effort

For an engineer who knows their own database schema: one focused day on the timeline spec, two to four days on field bindings and schedule arithmetic, a day on environment and CI, and a week or two of supervised running before you trust it. Two weeks is a fair estimate to first live send; a month is fair to comfortable.

:::tip
Before going live, run a full protocol cycle in dry-run mode against a test record. Leave `SEND_LIVE=false` (and `DRY_RUN` unset, which defaults to dry), add the test record to `TEST_PIDS` so it bypasses the eligibility gate, and let the pipeline, senders and daily audit run end to end. Dry runs still walk the entire decision path and write ledger rows, so you can read exactly what would have been sent, to which number, at which second — and the audit will tell you what it could not account for.
:::
