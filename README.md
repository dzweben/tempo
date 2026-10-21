<img src="site/img/logo.svg" alt="tempo" width="300">

**Tracking, Engagement, Messaging & Participant Outreach**

**[dzweben.github.io/tempo](https://dzweben.github.io/tempo/)**

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22925367.svg)](https://doi.org/10.5281/zenodo.22925367)

TEMPO runs the outbound side of a longitudinal study. It reads a study out of
REDCap or Qualtrics, works out who is owed a message today, sends it by text or
email, and keeps a record of everything it sent.

It does that for NIH-funded longitudinal research, covering visit reminders,
the questionnaires that open up after a visit, momentary-assessment prompts that
have to land on a particular minute, at-home task notices and compensation
emails, for several hundred participants.

This repository is published as a record of how that system works. It is not
software you can install, and there is no quickstart here, because there is no
honest version of one to write. [Running this for a real
study](#running-this-for-a-real-study) explains why.

---

## The problem

Almost everything a study sends to a participant is decided by a date that is
already sitting in the study database. Someone consents on the 4th, so their
baseline questionnaire opens on the 11th. They come in for a visit on the 3rd, so
the between-visit survey goes out a week later, and again the week after that
unless they have already filled it in. They are in the momentary-assessment arm,
so they get twenty-five prompts over the next ten days and each one has to arrive
at a specific minute.

In a study that runs for years, keeping on top of that is somebody's actual job,
every day. Doing it from a calendar instead goes wrong quietly. A reminder never
gets set. Someone who already responded gets chased anyway, which is the kind of
thing that makes people drop out. A prompt goes at 9:14 instead of 9:10, and the
answer it gets back sits in the dataset looking exactly like a good one. By the
time anybody notices, the window has closed and the data is gone.

The dates are already in the survey platform, and the messaging providers already
send texts and email. TEMPO connects the two and keeps a record of what it sent.

## What it handles

- **Reminders and sequences hung off each participant's own dates.** Follow-ups
  stop queueing the moment the form is marked complete, so people who have
  already answered stop hearing from you.
- **Momentary assessment (EMA/ESM).** A fixed set of weekday and clock-time
  slots, anchored to each participant's start date, delivered on the minute. If
  a prompt misses its window it gets logged as skipped.
- **Recurring cycles.** Monthly or weekly waves computed from one anchor date
  each, with their own invite and follow-up cadence.
- **Visit, at-home and compensation notices,** each with their own timing,
  conditions and expiry.
- **Per-participant survey links,** fetched from the survey platform at send
  time, so a message whose link did not resolve gets held back instead of going
  out broken.
- **A dashboard and a nightly reconciliation.** What is scheduled, what went
  out, how far each participant has got through their own sequence, and an
  overnight check of planned against actual so a missed message turns up the
  next morning.

## How it works

Every run does the same five things, start to finish.

1. **Pull.** Export the study over the REDCap or Qualtrics API, one call per
   event, and stitch it together on `record_id` so you end up with a single row
   per participant holding their dates, the completion flag on each instrument,
   and their contact details.
2. **Expand.** Run every rule against that row. Fill in the `[event][field]`
   references with that person's values, fetch the survey URLs the message
   needs, do the date arithmetic, and you get one dated line per participant for
   each time the message is owed.
3. **Select.** Narrow that to the lines falling in this run's window, and check
   each one's condition against the completion flags as they stand right now.
   Drop anyone who opted out, anything inside quiet hours, anything whose link
   did not resolve, and anything the ledger says already went.
4. **Send.** Claim the line so nothing else can take it, render the body with
   that person's details and survey URL in it, and hand it to the messaging
   provider or to SMTP.
5. **Record.** Write the send to the ledger. That line is what every later run
   checks against, which is how the same message never goes out twice.

### The grid

You never have to write a date down. You write the rule that produces one:
fourteen days after the baseline visit, then every week after that, up to three
times, and only while the form is still sitting incomplete. On each run TEMPO
takes those rules, runs them against whoever is currently on the roster, and gets
back one line per person for each time a message is owed, with a real timestamp,
somewhere to send it, and a body already filled in. Together those lines are the
whole schedule for the study.

The grid gets thrown away and rebuilt every run, and the only thing that survives
in between is the record of what already went out. Rebuilding from scratch is
what makes a correction cheap: when a coordinator fixes a wrong visit date in
REDCap, every message hanging off that date is simply correct on the next run.

### What counts as a trigger

A rule has two parts and both of them point at the study database. The condition
that decides whether a message is owed is a field reference, written
`[event][field]`, and so is the date its timing hangs off. There is no list of
message types anywhere in the code, and no special handling for momentary
assessment or for visit reminders. A condition is a field that is not marked
complete yet. An anchor is a date field on some event.

Which means schedules chain on their own. Logging a visit and marking an
instrument complete are both just a field changing, and some other rule is
sitting there watching that field. Log a visit and the questionnaires hanging off
it come due. Fill those in and their reminders stop, while the date you just
entered becomes the anchor for whatever comes next. That ordering is never
written down anywhere; it comes out of the field references, which is why a
three-year protocol that branches on what participants actually do still looks
like a flat list of rules.

### The clock

There is no daemon sitting there waiting. Cron calls the thing, and the only real
requirement is that it calls often enough that no slot falls through a gap
between runs. A reminder due at 5pm is covered by a run at 5pm. A prompt that has
to land at 8:10 needs runs overlapping that slot, because cron will not fire you
at 8:10:00 and there is no point pretending it will. The run picks the slot up
early and then sits there until the second comes around. In practice prompts land
two to four seconds after the second they were scheduled for, and that number
goes in the ledger next to every message, so if it ever starts drifting you can
see it happening.

You can run it as often as you like. Every run rebuilds the grid off a fresh
export and checks the ledger before it sends anything, so a spare invocation
finds nothing to do and exits. How often you call it comes down to how tight the
timing has to be.

## Not sending the same thing twice

You cannot unsend a text message, and many of the participants are minors. A
double-send or a text at 3am is a protocol violation. Three separate things have
to fail before the same message goes out twice.

- **The ledger.** Every send gets appended to a log keyed by participant,
  message, time, channel and recipient. Any later run checks that log before it
  does anything, so a retry, an overlapping schedule or a replayed job finds the
  message already accounted for and stops.
- **Claiming.** A run claims a slot before it transmits. If two runs reach the
  same slot at once, only one of them gets the claim and only that one sends.
- **Asking the provider.** Before anything goes out late or gets recovered, the
  system asks the messaging provider whether that message already reached that
  person. That covers the one case the ledger cannot: the message went out but
  the record of it was lost.

There are other guards around it. Nothing transmits outside the daily window. The
opt-out list is checked when the queue is built and checked again right before
sending, because somebody can opt out in between. A cap limits how much any one
run can send, so a bad rule cannot blast the whole roster. Dry-run is the
default, and there is a switch that puts everything back into dry-run without
waiting on a deploy.

## What a system like this needs

| | |
|---|---|
| **Survey platform** | A record export, date fields, per-form completion flags, and a per-participant survey link. The build here uses REDCap. |
| **SMS provider** | A send endpoint, and ideally a message-history endpoint so you can check whether something already arrived. The build here uses OpenPhone. |
| **Email** | SMTP credentials, or any HTTP send API. The build here uses Gmail SMTP. |
| **A scheduler** | Anything that can call a URL on a schedule: cron, a platform cron trigger, a CI timer. |
| **Somewhere to put two things** | The rebuilt grid, and the append-only record of what was sent. The reference implementation keeps both as JSON in an access-controlled store; object storage, a database or an encrypted volume all work. |

The survey platform stays the source of truth the whole way through. TEMPO holds
as little as it can about a participant, which comes down to a record identifier
and a way to contact them. [SECURITY.md](SECURITY.md) covers what that means in
practice.

The dashboard is Next.js, React, TypeScript and Tailwind. The pipeline and the
senders are Node scripts.

## Running this for a real study

Realistically, you cannot take this repository and run it for your own study
without me.

Sending to participants means holding their contact information, and it means
holding API credentials for the survey platform their data lives in. Both of
those are governed by your protocol, not by a licence file. In practice I would
need to be named on your IRB to have the access required to set it up and keep it
running.

So this is a description of a system that works, published so the design is
citable and inspectable. If you are running a longitudinal study with timing
requirements like these and want to talk about it, open an issue on this
repository. If you would rather build your own from the description above,
everything you need to know about the design is in this file and on
[the site](https://dzweben.github.io/tempo/).

## What is in this repository

Source files only. Study-specific identifiers were replaced with placeholders,
the schedule ships as a synthetic example instead of a real protocol, and no
participant data or credentials have ever been committed here. The dashboard
screenshots on the site are generated from made-up records. The reference CI
workflows under `examples/` come from a production deployment and are meant to be
read and adapted, not run as-is.

## License

See [LICENSE](LICENSE).

## Citation

Zweben, D. (2026). *TEMPO (Tracking, Engagement, Messaging & Participant Outreach):
automated survey scheduling and participant messaging for longitudinal studies*
[Computer software]. Zenodo. https://doi.org/10.5281/zenodo.22925367

That DOI always resolves to the newest version. To cite the exact release you
read, use the version DOI instead.
