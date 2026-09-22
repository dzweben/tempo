# Example data files

Synthetic examples of every file TEMPO reads and writes. The people, phone
numbers, links and record IDs here are invented.

In a real deployment these live in a **separate private repository** (see
[../../SECURITY.md](../../SECURITY.md)) — never in this one.

| File | Written by | Read by | Purpose |
|---|---|---|---|
| `participants.example.json` | fetch pipeline | dashboard, senders, audit | Roster snapshot: contacts, visit dates, per-instrument completion, cycle and prompt status |
| `due-reminders.example.json` | fetch pipeline | dashboard | Future-only display queue of upcoming messages |
| `sent-log.example.json` | general sender | dashboard, audit | Append-only idempotency ledger, one row per (message, channel, recipient) |
| `ema-prompt-schedule.example.json` | fetch pipeline | prompt sender | Exact send time, chosen contact number and pre-resolved link per prompt |
| `ema-sent-log.example.json` | prompt sender | dashboard, audit | Prompt delivery ledger, including protocol skips and send claims |
| `opt-outs.example.json` | hand-maintained | fetch pipeline, senders | Participants who asked to stop; enforced twice |
| `last-fetch.example.json` | fetch pipeline | dashboard | Freshness stamp and run metrics |

To run the dashboard against these, copy them into your data directory without
the `.example` suffix.
