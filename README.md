<img src="site/img/logo.svg" alt="tempo" width="300">

**Tracking, Engagement, Messaging & Participant Outreach**

**[dzweben.github.io/tempo](https://dzweben.github.io/tempo/)**

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22925367.svg)](https://doi.org/10.5281/zenodo.22925367)

TEMPO sends scheduled messages to study participants. It reads a study's roster,
date fields and per-form completion flags out of a survey platform, works out
which participants are owed a message and when, sends it by SMS or email, and
records every send.

It runs the participant outreach for NIH-funded longitudinal research — visit
reminders, follow-up sequences, momentary-assessment prompts and compensation
notices, to several hundred participants.

**This repository is published as a record of how that system works, not as
software you can install.** There is no quickstart, because there is no honest
version of one — see [Running this for a real study](#running-this-for-a-real-study).

---

## The problem

In a longitudinal study, almost everything that goes out to a participant is a
function of a date that already exists somewhere in the survey database. Consent
on the 4th, so the baseline questionnaire opens on the 11th. Visit on the 3rd, so
the between-visit survey goes out a week later and again a week after that, unless
they have already filled it in. Enrolled in the momentary-assessment arm, so
twenty-five prompts across the next ten days, each at a particular minute.

Done by hand this is somebody's job, every day, for years. Done with calendar
reminders it fails quietly: the reminder that was never set, the participant who
responded but got chased anyway, the prompt sent at 9:14 instead of 9:10 and
therefore measuring a different moment. By the time anyone notices, the window
has closed and the data is gone.

The dates are already in the survey platform. The messaging providers already
send texts and email. TEMPO is the part in between that connects them and keeps
a record.

## What it handles

- **Reminders and sequences anchored to each participant's own dates** —
  follow-ups that stop queueing the moment the form is marked complete, so
  people who have responded are not chased.
- **Momentary assessment (EMA/ESM)** — a fixed grid of weekday and clock-time
  slots, anchored per participant, delivered on the scheduled minute. Past a
  grace window a prompt is recorded as a protocol skip rather than sent late.
- **Recurring cycles** — monthly or weekly waves computed from one anchor date
  each, with their own invite and follow-up cadence.
- **Visit, at-home and compensation notices** — each with their own timing,
  conditions and expiry.
- **Per-participant survey links** — resolved from the survey platform at send
  time, so a message whose link does not resolve is never sent with a broken one.
- **A dashboard and a daily reconciliation** — what is scheduled, what went out,
  how far each participant has got through their own sequence, and a nightly
  check of planned against actual that surfaces a missed message the next
  morning rather than at the end of the study.

## How it works

Every run does the same five things, from scratch.

1. **Pull.** Export the current state of the study: the roster, the date fields
   each schedule hangs off, the completion flag on every form, and each
   participant's own survey link.
2. **Expand.** Each message is declared once as a rule rather than a date —
   *fourteen days after the baseline visit, repeating weekly, at most three
   times, only while the form is still incomplete.* Those rules are crossed
   against the roster to produce one row per participant per occurrence, each
   carrying a resolved timestamp, a destination and a rendered body. That grid
   is the entire schedule for the study.
3. **Select.** Take the rows whose timestamp falls inside this run's window and
   whose conditions still hold: form still incomplete, participant not opted
   out, not quiet hours, survey link resolved, and nothing matching already in
   the record of what has been sent.
4. **Send.** Claim the row, then transmit by SMS or email.
5. **Record.** Append to the log, so no later run can send the same row again.

The grid is rebuilt every time. Nothing persists between runs except the record
of what has already gone out, so correcting a date in the survey platform
corrects every message that hangs off it — there is no queue to migrate and no
second copy to reconcile.

### The clock

Nothing runs continuously. A cron schedule invokes the pipeline, and the only
real requirement is that the runs are frequent enough that every slot falls
inside one of them.

A reminder due at 5pm needs a run at 5pm. A momentary-assessment prompt that has
to land on a particular minute needs runs that overlap its slot, because
schedulers are not punctual — the run picks the slot up a little early and waits
inside the invocation until the exact second rather than trusting the cron tick
to be on time. Measured delivery in production is two to four seconds past the
scheduled second, written to the log for every message.

Running more often is safe. Each run recomputes the grid from the current export
and checks the record before transmitting, so a spare invocation simply finds
nothing to do. The cadence is set by how precise the timing has to be, not by
any risk of running too often.

## Not sending the same thing twice

A message that has gone out cannot be recalled, and the participants are real
people — many of them minors. A double-send or a 3am text is a protocol problem,
not a bug report. So at-most-once is enforced three independent ways:

- **A written record.** Every send is appended to a log keyed by participant,
  message, time, channel and recipient. Any later run checks that log first, so
  a retry, an overlapping schedule or a replayed job finds the message already
  accounted for and does nothing.
- **Claiming before sending.** A run claims a slot before it transmits. If two
  runs reach the same slot at once, only one of them wins the claim.
- **Asking the provider.** Before anything is sent late or recovered, the system
  asks the messaging provider whether that message already reached that person.
  The provider's own history settles it — which covers the one case the log
  cannot, where the message went out but the record of it was lost.

Alongside those: a daily quiet-hours window nothing transmits outside of, an
opt-out list checked when the queue is built and again at send time, a cap on
how many messages one run may send, a bounded window past which a late message
is skipped rather than delivered, dry-run as the default, and a switch that puts
the whole system into dry-run without a redeploy.

## What a system like this needs

| | |
|---|---|
| **Survey platform** | A record export, date fields, per-form completion flags, and a per-participant survey link. The build here uses REDCap. |
| **SMS provider** | A send endpoint, and ideally a message-history endpoint to arbitrate against duplicates. The build here uses OpenPhone. |
| **Email** | SMTP credentials, or any HTTP send API. The build here uses Gmail SMTP. |
| **A scheduler** | Anything that can call a URL on a schedule — cron, a platform cron trigger, a CI timer. |
| **Somewhere to put two things** | The rebuilt grid, and the append-only record of what was sent. The reference implementation keeps both as JSON in an access-controlled store; object storage, a database or an encrypted volume work the same way. |

The survey platform stays the single source of truth throughout. TEMPO holds as
little as it can about a participant — a record identifier and a way to contact
them. See [SECURITY.md](SECURITY.md) for what that means in practice.

Built with Next.js, React, TypeScript and Tailwind for the dashboard, and Node
scripts for the pipeline and senders.

## Running this for a real study

Realistically, you cannot take this repository and run it for your own study
without me, and I would rather say so than imply otherwise.

Sending to participants means holding their contact information and holding API
credentials for the survey platform that contains their data. Both of those are
governed by your protocol, not by a licence file. In practice that means I would
need to be named on your IRB to have the access required to set it up and keep
it running.

So this is not a guide. It is a description of a system that works, published so
that the design is citable and inspectable. If you are running a longitudinal
study with timing requirements like these and want to talk about it, open an
issue on this repository.

If you would rather build your own from the description above, everything you
need to know about the design is in this file and on
[the site](https://dzweben.github.io/tempo/). That would be a perfectly good
outcome.

## What is in this repository

Source files only. Study-specific identifiers were replaced with placeholders,
the schedule ships as a synthetic example rather than a real protocol, and no
participant data or credentials have ever been committed here. The dashboard
screenshots on the site are generated from synthetic records. Reference CI
workflows under `examples/` are taken from a production deployment and are meant
to be read and adapted rather than run as-is.

## License

See [LICENSE](LICENSE).

## Citation

Zweben, D. (2026). *TEMPO (Tracking, Engagement, Messaging & Participant Outreach):
automated survey scheduling and participant messaging for longitudinal studies*
[Computer software]. Zenodo. https://doi.org/10.5281/zenodo.22925367

That DOI always resolves to the newest version. To cite the exact release you
read, use the version DOI instead.
