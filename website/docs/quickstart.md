---
sidebar_position: 3
title: Quickstart
description: Clone TEMPO, run the coordinator dashboard against the synthetic example fixtures, then wire up real services without transmitting anything.
---

This gets you a working dashboard in about five minutes, with no survey database, no SMS account and no SMTP credentials. Nothing in Part 1 can send a message to anyone. Part 2 covers connecting real services, and the order in which to do it so your first live run is one you have already watched happen.

## Prerequisites

Node 20 or newer (the reference CI workflows pin `node-version: "20"`; Next.js 16 will not run on older) and npm. Everything else installs from `package.json` — the runtime dependency list is just `next`, `react`, `react-dom` and `nodemailer`.

## Part 1: dashboard on the example fixtures

### 1. Clone and install

```bash
git clone <your-fork-or-clone-url> tempo
cd tempo
npm install --no-audit --no-fund
```

Roughly 49 packages. TEMPO deliberately has almost no dependency surface.

### 2. Create your environment file

```bash
cp .env.example .env.local
```

To see the dashboard, exactly two values matter:

```bash
DASHBOARD_PASSWORD=pick-something-long
COOKIE_SECRET=pick-something-else-long
```

`src/lib/auth.ts` requires `DASHBOARD_PASSWORD` and will throw without it. `COOKIE_SECRET` is technically optional — `getCookieSecret()` falls back to `DASHBOARD_PASSWORD` — but set it anyway, because the fallback means rotating the dashboard password also invalidates every issued session cookie. Leave every other line in `.env.local` blank for now.

### 3. Copy the fixtures into the data directory

The data API routes (`src/app/api/data/*/route.ts`) all read from `path.join(process.cwd(), "private", "data", ...)`. That is the one path that matters, and `private/` is gitignored, so nothing you put there can be committed by accident.

```bash
mkdir -p private/data
for f in examples/fixtures/*.example.json; do
  b=$(basename "$f")
  cp "$f" "private/data/${b/.example/}"
done
```

That drops seven files into `private/data/`: `participants.json`, `due-reminders.json`, `sent-log.json`, `ema-sent-log.json`, `ema-prompt-schedule.json`, `opt-outs.json` and `last-fetch.json`. The same directory is what `outputFileTracingIncludes` in `next.config.ts` bundles into the serverless functions for `/api/data/participants`, `/api/data/sent-log`, `/api/data/audits` and `/api/ema-sweep` — locally the files are simply read off disk.

### 4. Start the dev server

```bash
npm run dev
```

Next starts on `http://localhost:3000`. You will see a deprecation notice about the `middleware` file convention; on Next 16.2.1 it is noise, and `src/middleware.ts` still enforces the auth gate correctly.

### 5. Log in

Open `http://localhost:3000`. `src/app/page.tsx` redirects to `/dashboard/overview`, the middleware sees no `tempo_auth` cookie and bounces you to `/login?next=/dashboard/overview`. Enter your `DASHBOARD_PASSWORD`. `POST /api/login` compares it in constant time, issues an HMAC-signed 30-day cookie, and returns you to the page you asked for.

:::note
The login route rate-limits to 5 attempts per IP per 15 minutes, in process memory. If you lock yourself out in dev, restart the server.
:::

### 6. What you will actually see

With one synthetic participant loaded, expect this:

| Page | With fixtures |
|---|---|
| Overview | 1 total participant, 1 due in next 7 days, per-wave completion table |
| Sent Log | 2 rows — the general ledger and the EMA ledger, merged and normalized by the route |
| Participants / Visit + Survey / Screen Time / EMA Tracker | The single fixture participant, cohort filter defaulting to "All cohorts" |
| Outgoing Queue | Empty |
| Daily Audit | Empty |
| Alerts & Logic | "0 alerts" |

The last three are expected, not broken:

- **Outgoing Queue** is future-only by design and the fixture reminder is dated January 2026. It will stay empty until you generate a real queue.
- **Daily Audit** reads `private/data/audits/index.json`, and no audit fixture ships. The route returns `[]` on any read failure.
- **Alerts & Logic** offers only Wave 2 and Wave 3 tabs (`[2, 3]` in `src/app/dashboard/alerts/page.tsx`), while every alert in the example `src/lib/timeline.ts` is `wave: 1`. Change either side and the twelve example alerts render with their full condition, send-date rule and message copy.

You will also see an amber banner on Overview reading "No REDCap fetch has run yet." The overview page expects `last-fetch.json` to carry a `timestamp` key; the shipped fixture uses `fetchedAt`. The banner is cosmetic and the rest of the page renders from real fixture data.

## Part 2: connecting real services

Verify each variable against the code before you trust it. These are the names actually read:

| Variable | Read by | Purpose |
|---|---|---|
| `REDCAP_API_URL`, `REDCAP_API_TOKEN` | `scripts/fetch-data.mjs`, `scripts/send-due-messages.mjs`, `/api/refresh`, `/api/redcap-probe` | Survey database of record |
| `QUO_API_KEY`, `QUO_FROM_NUMBER` | `scripts/send-due-messages.mjs`, `scripts/send-ema-prompts.mjs`, `/api/ema-sweep` | SMS provider |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | `scripts/send-due-messages.mjs` | SMTP (nodemailer) |
| `SWEEP_SECRET` | `/api/ema-sweep`, `/api/refresh`, `/api/redcap-probe` | Shared secret for cron-invoked routes |
| `CRON_SECRET` | Platform cron only | Must be set to the same value as `SWEEP_SECRET` — the route accepts `Authorization: Bearer ${SWEEP_SECRET}` |
| `GITHUB_DATA_TOKEN` | `/api/ema-sweep`, `/api/refresh` | Reads and writes the snapshot/ledger store through the contents API |
| `DRY_RUN` | Both sender scripts | `"true"` (the default) walks the full decision pipeline and transmits nothing |
| `MAX_SENDS_PER_RUN` | `scripts/send-due-messages.mjs` | Per-invocation blast cap, default 1500 |
| `REFRESH_MODE` | `/api/refresh` | `shadow` (diff only, writes nothing) or `live` |

:::warning
`SEND_LIVE` is not an env var the senders read. It is a **GitHub Actions repository variable**: `examples/workflows/refresh-data.yml` translates it into `DRY_RUN`, and `/api/refresh` reads it over the GitHub API via `ghVar("SEND_LIVE", ghToken)` alongside `SENDER_LEG`, failing safe to dry when unreadable. Setting `SEND_LIVE=false` in `.env.local` stops nothing. Keep it false in your repo variables, and rely on `DRY_RUN=true` for the scripts, until you have read a full dry-run log line by line and agree with every decision it made.

The sharper hazard: **`/api/ema-sweep` has no dry-run gate at all.** It arms the moment `SWEEP_SECRET`, `QUO_API_KEY` and `QUO_FROM_NUMBER` are all present, and anyone holding the secret can fire it. Do not populate those three together until you mean it.
:::

A safe order: set only `REDCAP_API_URL` and `REDCAP_API_TOKEN`, run `node scripts/fetch-data.mjs` (it exits immediately without a token), and inspect the regenerated `private/data/` files in the dashboard. Then add the messaging credentials and run `DRY_RUN=true node scripts/send-due-messages.mjs`, which prints every send it would have made. Only then consider going live.

:::danger
`private/data/` holds real participant contact information once you connect a survey database. It is gitignored here on purpose — in a deployment these files belong in an access-controlled store, and TEMPO needs only a record identifier and a contact endpoint per participant. See `SECURITY.md`.
:::

Two things you will have to edit rather than configure: `/api/ema-sweep` and `/api/refresh` both hardcode `const REPO = "YOUR-GITHUB-ORG/YOUR-DATA-REPO"` — the `GITHUB_REPOSITORY` variable in `.env.example` is read only by `scripts/daily-audit.mjs`, and that script reads `GITHUB_TOKEN`, not `GITHUB_DATA_TOKEN`. `COMPLETION_REPORT_IDS` appears in `.env.example` but is not referenced anywhere in `src/` or `scripts/`.
