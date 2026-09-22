# Reference CI workflows

These are the scheduled jobs from a production TEMPO deployment, kept as
**reference skeletons**. They are deliberately *not* in `.github/workflows/`,
because they would not run correctly in a fresh clone: they assume a repository
layout where the app lives in an `app/` subdirectory, and they read and commit
participant data files that belong in a separate private repository.

Read them for the patterns, then adapt:

| File | What it demonstrates |
|---|---|
| `refresh-data.yml` | Scheduled pull from the survey database → derived queues → commit → deploy, with a run-time uptime gate and a serialized concurrency group |
| `send-due-messages.yml` | Standalone sender invocation, including recovery/dry-run dispatch inputs |
| `ema-prompt-sender.yml` | Long-lived segment jobs for momentary-assessment prompts (superseded by the serverless minute-cron route, kept as the alternative approach) |
| `daily-audit.yml` | Daily reconciliation of planned vs. actual sends |
| `deploy-code.yml` | Deploy-on-push with a data-validation gate before shipping |
| `ema-sweep-setup.yml` | One-time provisioning of secrets into the hosting platform, plus live credential verification |

To use them: move the ones you want into `.github/workflows/`, drop the
`working-directory: app` defaults, point the data paths at your private data
repository, and set the secrets each one references.
