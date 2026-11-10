# Security

## Participant data

TEMPO needs a stable survey record identifier and contact endpoints: a phone number, an email address, or both. Dates, completion flags and schedule state are derived. Names and free-text fields are pulled only when the dashboard displays them.

The survey platform remains the system of record. TEMPO rebuilds its disposable working copy each run, then uses it to determine what is owed without querying the survey database repeatedly.

A personal survey URL grants access to that participant's responses and is a credential. TEMPO resolves links at send time without storing them.

## State and access

Two kinds of state persist. Snapshots contain the derived roster and queues. Append-only ledgers record what was sent. This deployment stores both as JSON in a separate access-controlled repository, giving every change a timestamped history and keeping concurrency simple.

The code requires storage with read-modify-write operations and an optimistic concurrency check. Object storage, a managed database or an encrypted volume could also serve.

Credentials live in the deployment platform's environment configuration and the CI provider's secret store. No credentials are committed to either repository.

The dashboard has a public URL. A single shared password gates access through a signed cookie checked on every route.

Sending is off by default. A runtime flag switches the whole system to dry-run without a redeploy.

## Source repository and vulnerability reports

The source repository contains code and synthetic examples only. The example schedule describes a fictional study, and fixtures contain invented people. No participant data or credentials have ever been committed to the source repository.

Vulnerability reports are preferred through a private security advisory on the repository.
