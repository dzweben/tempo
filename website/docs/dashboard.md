---
sidebar_position: 7
title: The dashboard
description: The password-gated coordinator web app — ten pages that answer who is behind, what goes out next, and whether last night's sends actually happened.
---

The dashboard is the human end of TEMPO. It reads the same JSON the pipeline writes and the senders consume, and — with one exception — it writes nothing: no button anywhere in `src/app/dashboard/` sends a message, edits a record, or changes a schedule. A coordinator uses it to answer three recurring questions: who is behind, what goes out next, and did last night's sends actually happen.

Every page is a client component fetching from `/api/data/*`, thin readers over files in `private/data/`: `participants.json`, `due-reminders.json`, `sent-log.json` plus `ema-sent-log.json`, `last-fetch.json`, and `audits/`. The layout at `src/app/dashboard/layout.tsx` wraps all of them in `<CohortProvider>` and `<DashboardShell>`.

## Getting in

`src/middleware.ts` runs on every request except Next internals and static assets. Anything outside `PUBLIC_PATHS` needs a valid cookie; API calls without one get a 401, page requests get redirected to `/login?next=…`. The login form (`src/app/login/page.tsx`) POSTs to `/api/login`, which compares the submitted string to `DASHBOARD_PASSWORD` in constant time (`safeEqual` in `src/lib/auth.ts`), then issues `issuedAt.HMAC-SHA256(secret, issuedAt)` as an httpOnly, `sameSite: "strict"` cookie good for 30 days. A per-IP in-memory limiter allows five attempts per fifteen minutes and resets on cold start.

That is the whole model: **one shared password, no user accounts.** A reasonable fit for a small coordinator team, with consequences worth stating plainly.

:::warning What the shared password implies
The dashboard URL is public, so the password is the only barrier — make it long and random, not the study acronym. There is no per-user identity: the sent log tells you what the server did, never who was looking.

Rotating on a staff change takes care. `getCookieSecret()` prefers `COOKIE_SECRET` and only falls back to `DASHBOARD_PASSWORD`. If you set `COOKIE_SECRET` separately, changing the password does **not** invalidate existing cookies, and a departing staffer's session stays valid for up to 30 days. Rotate both.

There is also no sign-out in the UI. `/api/logout` exists and clears the cookie, but nothing in `src/components/DashboardShell.tsx` calls it.
:::

## The pages

`DashboardShell` renders a fixed ten-item sidebar (collapsible below `lg`) and nothing else stateful.

| Page | Route | Reads | Answers |
| --- | --- | --- | --- |
| Overview | `/dashboard/overview` | participants, last-fetch, due-reminders | Is the pipeline alive, and where does the study stand? |
| Participants | `/dashboard/participants` | participants | Who is this PID and how do we reach them? |
| Visit + Survey Overview | `/dashboard/waves` | participants | Where is each participant in the wave lifecycle? |
| Screen Time Surveys | `/dashboard/sts` | participants | Which survey cycles are still outstanding? |
| EMA Tracker | `/dashboard/ema` | participants | Who is answering prompts, and which ones? |
| Outgoing Queue | `/dashboard/reminders` | due-reminders, participants | What will the sender transmit, to whom, saying what? |
| Session Notes | `/dashboard/session-notes` | last-fetch (for the sheet ID) | The coordinator workbook, embedded live. |
| Sent Log | `/dashboard/sent-log` | sent-log + ema-sent-log | What actually went out? |
| Daily Audit | `/dashboard/audit` | audits index + per-day report | Did yesterday reconcile? |
| Alerts & Logic | `/dashboard/alerts` | `src/lib/timeline.ts` | What is this message supposed to do? |

**Overview** opens with a freshness banner driven by `last-fetch.json` — green with a timestamp and counts, amber if no fetch has ever run, red with the error if the last one failed. Then four marquee counts and a per-wave completion table. Read the ratios carefully: `computeStats()` in `src/lib/tempo-utils.ts` uses `totalParticipants` as the denominator for every column, not the per-wave active count, so a wave that has barely started reads low by design. "Done" thresholds are coordinator-defined constants in the same file — at-home ≥ 7 of 8 sections, STS ≥ 5 of 9 surveys, EMA ≥ 10 of 25 prompts.

**Participants** is the roster directory: PID, email, primary phone, active wave, and the `cohortGroup` label from the coordinator sheet. Rows expand to contact details and a per-wave summary; search matches PID and email.

**Visit + Survey Overview** is the lifecycle grid — V1, at-home, STS1 (six squares), EMA, STS2 (three squares), V2 — one wave at a time. The `CycleStrip` squares stay gray when the cycle is not active, so "not started" and "started but unanswered" never look alike.

**Screen Time Surveys** flattens STS1 and STS2 into nine columns (1.1–1.6, 2.1–2.3), each cell a completion letter over a date — the REDCap date when there is one, otherwise the month label from the coordinator sheet. `combinedCycles()` merges those sources, and the row filter admits anyone with `sts1`, `sts2`, **or** a `followupSheet` row, so a participant the sheet has scheduled but REDCap has not yet provisioned still appears instead of silently vanishing. An incomplete cell with a resolved `surveyLink` is a hyperlink — how a coordinator completes a survey with a participant on the phone.

**EMA Tracker** shows prompt progress per participant, expanding to all 25 slots with day label, clock time, and either a checkmark or the scheduled timestamp. Two eligibility rules are hardcoded in the row filter: PIDs matching `/^1\d{3}$/` never get EMA, and anyone under 13 is excluded. Unknown age falls through deliberately — better to surface the row than hide it.

**Outgoing Queue** is the page coordinators live in. Rows group by Eastern day and filter by scope (Today / 24h / 7d / 14d / All, defaulting to 7d), by kind, by a hide-already-completed checkbox that is on by default, and by free text. Expanding a row shows the recipients with per-channel pills that turn **red when the contact field is missing**, the alert metadata, the survey link (or "Will be resolved at send time"), and a preview produced by `renderMessageTemplate()`, which mirrors the sender's renderer so the preview is the real text. EMA-enable rows additionally render the 25 prompts that would fire if the participant enables before the upcoming Monday.

**Session Notes** embeds the live Google Sheet in an iframe, using the sheet ID from `last-fetch.json` with a constant fallback. This is the one page that can change anything, and it does so with the *viewer's* own Google login — TEMPO's service account is not involved.

**Sent Log** merges both ledgers; `/api/data/sent-log` normalizes EMA rows into the general shape, folding delivery latency into the instrument label and mapping `skipped_late` to `skipped`. Headline counts exclude `dryRun` rows and count them separately, and rehearsal rows carry a REHEARSAL badge — mixing them in once made a dry run look like a live blast.

**Daily Audit** lists each day with a GREEN/YELLOW/RED dot and opens the full report: problems and warnings, planned vs sent vs failed vs unaccounted, EMA median and worst-case delivery latency in seconds, per-bucket detail tables (`unaccounted` is bordered red), and per-workflow run counts.

**Alerts & Logic** is a reference view over `TIMELINE_ALERTS`. Each row expands to its trigger, send-date rule, condition, destination fields and template copy, above an amber "send caveat" restating the completion gate in plain English. Its wave toggle offers only waves 2 and 3.

## Cohort filter

Seven of the ten pages carry `<CohortFilter />`. Cohorts are derived purely from the numeric PID prefix in `src/lib/cohort.tsx` — 1000–1999, 2000–2999, 3000–3999 — held in React context and persisted to `localStorage` so the choice survives navigation and reload. It is a display filter only; it never changes what the sender does. Note that this is a different thing from the `cohortGroup` string shown on the Participants page, which comes from the coordinator sheet.

## Time zone

Every date and time in the dashboard renders in Eastern, never the viewer's local zone, because every send fires in Eastern. The rule lives in one place:

```ts
// src/lib/tempo-utils.ts
const ET = "America/New_York";
```

`formatDate`, `formatTime`, `formatDateTime`, `relativeDate` and `easternDayKey` all pass that as `timeZone`. Bare `YYYY-MM-DD` strings are formatted from their components instead, so a wall-clock date can never shift a day. Without this, a coordinator on Pacific time would see a 5 PM ET send roll back to the previous afternoon.

:::danger Known rough edges
`ET` is a module-level constant, not configuration — adapting TEMPO to another zone means editing that line and the literal `"America/New_York"` inside `src/app/dashboard/reminders/page.tsx`, plus the sender and pipeline.

The Outgoing Queue groups by Eastern day but its Today scope filter uses the *browser's* local midnight boundaries, so a non-Eastern viewer can see the two disagree at the edges.

`src/lib/postponed.ts` promises a POSTPONED badge on the dashboard. No page renders one; the sender reads `private/data/postponed.json` instead, and that module is currently unused.
:::
