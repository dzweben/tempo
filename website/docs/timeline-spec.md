---
sidebar_position: 4
title: The timeline spec
description: How src/lib/timeline.ts declares every message a study sends, and exactly which of its fields the runtime reads.
---

Every automated message TEMPO sends is one row in `src/lib/timeline.ts`. The file's own header
says it plainly: "Nothing else in the codebase decides what gets sent." The version in the
repository is a synthetic example for a fictional study — ten alerts that between them exercise
every supported message kind — not a runnable protocol.

Before the field reference, one thing has to be said up front, because it shapes everything else.

:::warning The spec has two audiences, and they read different fields
The timeline spec is read in two places, and they do not read the same thing.

**The dashboard** (`src/app/dashboard/alerts/page.tsx`) imports `TIMELINE_ALERTS` as TypeScript and
renders *every* field — `condition`, `sendDateSpec`, `destinationSpec`, `trigger`, `emaKey`,
`channels`, `message`. For a coordinator, this page is the protocol document.

**The senders** parse `timeline.ts` as *text*. `loadTimeline()` in
`scripts/send-due-messages.mjs` runs one regex over the file and keeps only four fields:
`alertId`, `wave`, `kind`, `instrument`, and `message`. `scripts/send-ema-prompts.mjs` and
`src/app/api/ema-sweep/route.ts` go further and extract a single template — the `message` of
`alertId: 64`.

There is **no parser** for `condition` or `sendDateSpec` anywhere in the repository. The scheduling
arithmetic those strings describe is hand-written in `computeDueReminders()` in
`scripts/fetch-data.mjs`. `condition`, `sendDateSpec`, `destinationSpec` and `trigger` are precise,
human-readable documentation of logic that lives in two places at once. Treat them as a contract you
maintain by hand, not as configuration the machine obeys.
:::

## The TimelineAlert interface

| Field | Type | Read by | Meaning |
|---|---|---|---|
| `alertId` | `number` | dashboard + senders | Stable identifier. The join key between a queue row and its template. Corresponds to the "Alert #" column of the coordinator's spreadsheet. |
| `wave` | `WaveYear` (`1 \| 2 \| 3`) | dashboard + senders | Which study year this row belongs to. Longitudinal studies repeat their message set per wave. |
| `kind` | `AlertKind` | dashboard + senders | The message family. Drives channel routing, subject lines and the completion gate shown in the UI. |
| `instrument` | `string` | dashboard + senders | Human label, e.g. `"Monthly Survey Follow-up 1.1"`. Written to every ledger row, so it is what a coordinator reads in the sent log. |
| `trigger` | `string \| null` | dashboard only | The database event that makes this message owed, when there is one (e.g. a visit timestamp being stamped). `null` means "scheduled datetime send". |
| `condition` | `string \| null` | dashboard only | Survey-database logic deciding whether the message is owed at all. |
| `sendDateSpec` | `string \| null` | dashboard only | The anchor date field, plus an optional natural-language cadence clause. |
| `destinationSpec` | `string \| null` | dashboard only (but see `channels`) | `[event][field]` references to the contact fields to use. |
| `channels` | `Channel[]` | dashboard only | **Derived**, not authored — `parseChannels()` computes it from `destinationSpec`. |
| `emaKey` | `string \| null` | dashboard + queue rows | For momentary-assessment prompts only: the slot key within the prompt grid. |
| `message` | `string \| null` | dashboard + senders | The template body. The one field the runtime truly depends on. |

`TIMELINE_ALERTS` is built at module load by mapping the `RAW` array through `parseChannels`. Three
helpers ship alongside it — `alertsForWave`, `alertById`, `alertsForRuntimeWave` — but as written,
`alertsForRuntimeWave` only delegates to `alertsForWave`, and neither it nor `alertById` has a
caller. Both dashboard pages filter `TIMELINE_ALERTS` inline.

## AlertKind

`kind` is the switch the rest of the system keys off. Twelve values:

| Kind | What it is |
|---|---|
| `sts1_invite` / `sts2_invite` | The opening message of a recurring survey cycle. |
| `sts1_followup` / `sts2_followup` | Reminders inside that cycle, which stop the moment the survey is complete. |
| `athome_sms` / `athome_email` | The take-home questionnaire handoff after an in-person visit. One row per channel — the split exists so each channel gets its own wording. |
| `ema_enable` | The nudge asking a participant to opt in and confirm which number to text before a momentary-assessment cycle starts. |
| `ema_prompt` | One slot in the prompt grid. |
| `payment_email` | The initial compensation notice. |
| `payment_followup` | The recurring "still unclaimed" reminder. |
| `payment_expire` | The link-expiry warning. |
| `other` | Escape hatch. Nothing routes it. |

The dashboard hard-codes a plain-English completion gate per kind in `SEND_CAVEAT`
(`alerts/page.tsx` line 44) — the universal off-switch, stated for coordinators who will never read
`condition`.

## condition

The syntax is REDCap branching logic: `[event_name][field_name]` compared with `=`, `<>` or `''`.

```ts
condition: "[survey_y1_arm_1][monthly_1_complete]<>2",   // survey not yet complete
condition: "[ema_y1_arm_1][ema_enabled]=''",             // enable form never answered
condition: "[payment_y1_arm_1][payment_claimed]<>1",     // compensation unclaimed
```

`2` is REDCap's "Complete" code (`CompletionCode` in `src/types/index.ts`: 0 incomplete, 1
unverified, 2 complete). Almost every condition in the example reduces to "the thing this message is
about is still outstanding."

The runtime enforces the *same* idea, twice, in hand-written code. In
`scripts/fetch-data.mjs`, `queueSts()` does `if (c.complete === 2) return;` before emitting either
an invite or a follow-up, and the at-home block requires
`ah.athomeMeasuresComplete !== 2`. Then `scripts/send-due-messages.mjs` filters again at send time
(`if (d.complete) return false;`) against data fetched minutes earlier. That second check is the
point: a participant who finishes a survey between the fetch and the send does not get the reminder.

## sendDateSpec

Two shapes appear in the example spec. A bare field reference:

```ts
sendDateSpec: "[survey_y1_arm_1][monthly_1_date]"
```

Or a field reference wrapped in a cadence clause:

```ts
"3 days after [survey_y1_arm_1][monthly_1_date] repeat every 3 days up to 2 times"
"14 days after [payment_y1_arm_1][payment_ready_date] repeat every 14 days up to 4 times"
"5 days after [payment_y1_arm_1][payment_ready_date]"
"90 days after [payment_y1_arm_1][payment_ready_date]"
"3 days 8 hours before [ema_y1_arm_1][ema_start_day]"
```

Read that as: `<offset> (before|after) <field> [repeat every <interval> up to <N> times]`, where an
offset may combine days and hours.

:::danger No code parses these strings
The forms above are the forms the example spec uses. They are not a grammar any function
implements. Search the repository for `repeat every` and the only hits are in `timeline.ts` itself
and in the alerts page that displays it.

The real schedule is computed in `computeDueReminders()`, and each family's arithmetic is a separate
hand-written block:

- **At-home** (`fetch-data.mjs` line ~875): `timestamp_athome + 3h45m`, a single send, no follow-ups.
- **Recurring cycles**: the invite fires on the cycle date; follow-ups are `[3, 6]` days after it —
  with a one-time `[3, 5]` override for August 2026 so a slipped cycle stayed inside its month.
- **EMA enable**: `start_day − 3d8h`, anchored at midnight Eastern, with a weekly roll-forward
  capped at four weeks.
- **Compensation**: initial at `+5d`, follow-ups every 14 days, expiry three calendar months after
  the initial.

Change a cadence in the spec and you have changed the documentation. You must change
`computeDueReminders()` too.
:::

The offsets are not arbitrary. The at-home 3h45m gap keeps the text from landing while the
participant is still in the building. And the EMA enable anchor comment is explicit that the default
date-only hour of 9 AM made "3d8h before" land at 1 AM, so the anchor was forced to midnight
Eastern — the kind of bug that only surfaces once it has texted somebody at one in the morning.

## destinationSpec and channels

`destinationSpec` holds `[event][field]` references to contact fields. Multiple recipients on one
channel are separated by `;`, and the example defines a shared constant:

```ts
const CONTACTS = "[enrollment_arm_1][phone_primary]; [enrollment_arm_1][phone_secondary]\t[email]";
```

`parseChannels()` (line 61) is deliberately crude — it lowercases the string and looks for
substrings:

```ts
if (s.includes("phone")) out.push("sms");
if (s.includes("email")) out.push("email");
```

So a spec naming any phone field gets SMS, any email field gets email, and `CONTACTS` gets both.
`channels` feeds the badges on the alerts page and nothing else.

:::note The sender does not use `channels`
`scripts/send-due-messages.mjs` has its own `KIND_CHANNELS` map (line 245) keyed by `kind`, with the
comment "mirrors the Timeline destinationSpec." Actual recipients come from the participant record,
not the spec: `[p.contact.phonePrimary, p.contact.phoneSecondary].filter(Boolean)` for SMS and
`p.contact.email` for email, with one ledger row per `(reminder, channel, recipient)`. If you add a
kind, add it to `KIND_CHANNELS` or it silently routes to no channel at all.
:::

## Message templates

Two token families, resolved at different moments.

**Merge placeholders** are substituted from the fetched participant snapshot. The substitution table
is fixed — `renderMessage()` in `send-due-messages.mjs` line 108, mirrored by
`renderMessageTemplate()` in `src/lib/tempo-utils.ts` so the queue page can preview the exact text:

| Token | Source |
|---|---|
| `[preenrollment_arm_1][first_name]` | `contact.firstName` |
| `[preenrollment_arm_1][last_name]` | `contact.lastName` |
| `[preenrollment_arm_1][parent_name]` | `contact.parentName` |
| `[preenrollment_arm_1][email]` | `contact.email` |
| `[preenrollment_arm_1][phone_primary]` / `[phone_secondary]` | the corresponding contact fields |
| `[name]` | alias for `contact.firstName` |
| `[expire_date]` | formatted link-expiry date carried on the queue row |
| `[survey link]` | alias for the first resolved link |

:::warning The example spec's merge prefix does not match the renderer
The example rows use `[enrollment_arm_1][first_name]`; the substitution table is keyed on
`[preenrollment_arm_1][first_name]`. The table is a literal string map, not a pattern — an
unrecognized key passes through untouched and a participant receives the raw token. The renderer is
also what the progressive-nudge ladder for `ema_enable` keys on, matching an exact
`[preenrollment_arm_1][first_name]` opening line. Whatever prefix your database uses, the spec and
`renderMessage()` must agree on it exactly.
:::

**Survey-link tokens** are the other family, and these *are* pattern-matched:

```js
out.replace(/\[([a-z0-9_]+)\]\[survey-link:([a-z0-9_]+)\]/gi, (_m, evt, instr) => ...)
```

`[event][survey-link:instrument]` resolves to that participant's personal survey URL. Resolution is
just-in-time, at send time, via the survey database's `surveyLink` endpoint — three attempts with
backoff, memoized in `linkCache`. Before the call, `remapEventForWave()` rewrites `_y2_` to the
participant's actual wave, because templates are authored against one wave's event slugs and a
wave-1 participant must not receive a year-2 link.

If a link cannot be resolved, the message is **not sent**. It is logged `skipped` with
`"survey link unresolved — message NOT sent"`, because the alternative is texting a participant the
literal string `[SURVEY LINK PENDING]`.

## emaKey and prompt grids

For `ema_prompt` rows only, `emaKey` names the slot: weekday plus clock time, e.g. `"ema_mon_1000"`.
A real study defines one row per slot; the example ships two.

The production grid is not read from the spec. `EMA_PROMPTS` in `fetch-data.mjs` (line 59) is a
hard-coded array of 25 `[field, dayLabel, timeLabel]` triples, and the comment explains why the
labels must be carried explicitly: the field names do not encode AM/PM, so `ema_sa_501` cannot be
disambiguated from its digits alone. `computeEmaPromptDates()` expands the grid against the cycle's
start Monday. `emaKey` survives onto queue rows, where `linkSpec()` uses
`EMA_PROMPT_FIELDS.indexOf(d.emaKey)` to work out which instrument's link to resolve.

All prompts share one body: both `send-ema-prompts.mjs` and the `ema-sweep` route extract the
`message` of `alertId: 64` by regex, so in a production spec alert 64 is load-bearing.

## A worked example, end to end

Follow `alertId: 2` — the monthly survey follow-up — matching
`examples/fixtures/due-reminders.example.json`.

1. **Declared.** `kind: "sts1_followup"`, condition `[survey_y1_arm_1][monthly_1_complete]<>2`,
   cadence "3 days after … repeat every 3 days up to 2 times", `destinationSpec: CONTACTS` →
   `channels: ["sms", "email"]`.
2. **Queued.** `fetch-data.mjs` pulls the participant's record, pivots it, and reaches `queueSts()`.
   The cycle is not complete, so for each offset in `[3, 6]` it emits a row:
   `{ pid: "1001", alertId: 2, kind: "sts1_followup", instrument: "Monthly Survey Follow-up 1.1", scheduledAt: "2026-01-23T22:00:00.000Z", complete: false }`.
   The row carries no message and no condition — only the join key.
3. **Split.** Future-only rows go to `due-reminders.json` for the dashboard; the same rows plus
   anything due in the last 24 hours go to `send-candidates.json` for the sender. That split exists
   because pruning just-past items at every fetch once starved the sender of an entire cycle.
4. **Fired.** `send-due-messages.mjs` keeps rows whose `scheduledAt` falls in
   `(windowStart, now]`, drops opt-outs, postponed PIDs and completed items, then calls
   `findTemplate(2, 1, "sts1_followup")` — exact `alertId` + `wave` first, then `alertId` alone, then
   `kind` + `wave`.
5. **Rendered.** `[enrollment_arm_1][first_name]` and the `[survey_y1_arm_1][survey-link:monthly_1]`
   token are substituted, the link resolving against `survey_y1_arm_1` for a wave-1 participant.
6. **Sent.** `KIND_CHANNELS.sts1_followup` is `{ sms: true, email: true }`, so the body goes to both
   phone numbers and the email address — three ledger rows, three distinct `sendKey`s of the form
   `pid|alertId|scheduledAt|channel|recipient`. The ledger is written after every participant so a
   crash loses nothing.

:::tip Alert numbering is where the example and the pipeline diverge
The example spec numbers its rows 1–10. The shipped `fetch-data.mjs` emits the production
deployment's numbers (48–59 for cycles, 60/61 at-home, 63 enable, 64–88 prompts, 89–95, 287/289/290
for compensation). Run them together and `findTemplate`'s third fallback tier — match on `kind` +
`wave` — is what saves you. That fallback is worth keeping, but renumbering the spec to match your
pipeline is the honest fix.
:::

## Authoring a spec for a new study

Work in this order.

1. **Enumerate the messages.** One row per message *per channel per wave*. A message that texts and
   emails with different wording is two rows, as `athome_sms` and `athome_email` are.
2. **Pick alert IDs and never reuse them.** They are the join key to queue rows and to every
   historical ledger entry. Reusing one silently rewrites the meaning of your audit trail.
3. **Write `condition`, `sendDateSpec` and `destinationSpec` as documentation** — precisely, for the
   human reading the alerts page — and then implement the matching arithmetic in
   `computeDueReminders()`. Keep the two in the same commit.
4. **Add your kinds to `KIND_CHANNELS`** and to `SEND_CAVEAT` / `KIND_LABEL` / `KIND_COLOR` on the
   alerts page.
5. **Match your merge-placeholder prefix** to the substitution tables in both `renderMessage()` and
   `renderMessageTemplate()`.
6. **Run `DRY_RUN=true` first.** It exercises the whole decision pipeline, logs every render, and
   sends nothing. Dry-run rows are marked and deliberately do not satisfy "already sent," so a
   rehearsal can never block the real send.

:::danger Keep the file regex-parseable
`loadTimeline()` matches objects that open with `alertId`, then `wave: N as WaveYear`, then `kind`,
then `instrument`, and *end* with `message:` followed by `},`. `message` must be a single
double-quoted string literal or `null` — a template literal, or two strings joined with `+`, will not
match and the row will be silently skipped. The function throws if it parses zero entries, which
catches a wholesale format change but not a single malformed row. After editing, check that the
sender's parse count equals your row count.
:::

The production pattern is to **generate this file from a spreadsheet** the coordinators maintain —
one row per alert, columns matching the interface above. Message wording, cadence and channel
routing then stay with the people who own the protocol and the IRB approval, while engineers own the
arithmetic those rows describe. It also means a wording change is a regenerate-and-commit, with the
diff legible to a reviewer who has never read TypeScript.
