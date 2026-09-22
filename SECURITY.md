# Security

## Handling participant data

TEMPO needs two things about a participant to do its job: a stable **record
identifier** from your survey database, and the **contact endpoints** to reach
them — a phone number, an email address, or both. Everything else it works with
is derived: dates, completion flags, schedule state.

Design your deployment around that.

- **Store the minimum.** The reference pipeline builds a participant snapshot
  from your database. Pull the identifiers and contact fields the sender needs
  and the completion flags the dashboard displays. Names, dates of birth and
  free-text fields are not required for delivery; if your dashboard does not
  need them on screen, do not pull them into the snapshot.
- **Keep your survey database the system of record.** TEMPO holds a working
  copy so it can decide what is owed without hammering your database on every
  tick. It is a cache, not an archive — treat it as disposable and rebuildable.
- **Survey links are credentials.** A personal survey URL grants access to that
  participant's responses. They appear in queue files and in message bodies;
  protect those files accordingly, and prefer resolving links at send time
  (which the sender already does) over persisting them longer than needed.

## Where state lives

TEMPO persists two kinds of state: snapshots (the derived roster and queues)
and ledgers (the append-only record of what was sent). The reference
implementation keeps both as JSON in a **separate, access-controlled**
repository, which gives every change a timestamped history at no cost and makes
the concurrency model simple — see
[the data model documentation](https://dzweben.github.io/tempo/docs/data-model)
for the file shapes and the compare-and-swap write path.

That is a reasonable default, not a requirement. Object storage, a managed
database, or an encrypted volume all work; what the code depends on is a store
that supports read-modify-write with an optimistic concurrency check. Whatever
you choose:

- Put it behind authentication and restrict access to the study team.
- Keep it out of any repository you publish, and out of build artifacts.
- Apply your institution's retention and disposal policy to it, the same as any
  other copy of study data.
- If your protocol or IRB requires it, encrypt at rest and log access.

## Credentials

Everything in `.env.example` is a secret except the placeholder URLs. Keep all
of it in your deployment platform's environment configuration and your CI
provider's secret store — never in the repository, never in a README, never
committed "temporarily."

- Scope tokens as narrowly as the provider allows.
- Rotate anything that has appeared in a shell history, a log file, a
  screenshot, a chat message, or a support ticket.
- The dashboard is served from a public URL and gated by a single shared
  password. Use a strong one, rotate it when staff change, and consider putting
  the deployment behind your institution's SSO or a network restriction if your
  hosting platform supports it.
- Keep `SEND_LIVE` false until you have watched a dry run produce the messages
  you expect. It is the fastest way to stop everything if something looks wrong,
  and it takes effect without a deploy.

## This repository

This repository contains source code and synthetic examples only. The example
timeline spec describes a fictional study; the example fixtures contain invented
people. No participant data and no credentials have ever been committed here.

## Reporting a vulnerability

Please open a private security advisory on the repository rather than a public
issue.
