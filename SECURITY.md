# Security

## Containment and dashboard masking

REDCap remains the system of record. Survey responses stay in the survey database. TEMPO never reads or stores participants' answers.

The data API routes mask contact details server side before returning dashboard data. The browser never receives real names, email addresses, or phone numbers. Masking covers first name, last name, parent name, email, primary phone, secondary phone, child phone, and momentary-assessment phone.

Examples show the retained characters:

- Name: `Jordan` → `J***n`
- Email: `a.person@example.org` → `a***n@e***e.org`
- Phone: `(555) 010-0199` → `5***9`

These fragments help coordinators distinguish participants. The sent log applies the same masking to recipients, including recipients embedded in send keys.

## Working data and survey links

TEMPO holds each participant's stable record identifier, contact endpoints, schedule anchor dates, and per-instrument completion flags. A disposable working copy is rebuilt every run to determine what is owed while limiting repeated survey database queries.

Personal survey URLs grant access to participants' responses and count as credentials. They are resolved at send time and never stored.

## State and access

Snapshots contain the derived roster and queues. Append-only ledgers record sends. Both persist as JSON in a separate access-controlled repository with timestamped change history. Storage requires read-modify-write with an optimistic concurrency check.

Credentials reside in deployment environment configuration and the CI provider's secret store.

The dashboard has a public URL. A single shared password gates access through a signed cookie checked by middleware on every route.

Sending is off by default. A runtime flag returns the whole system to dry-run without redeployment.

## Repository and vulnerability reporting

This source repository contains code and synthetic examples. The example schedule describes a fictional study, and fixtures contain invented people. No participant data or credentials have ever been committed.

Private repository security advisories are the preferred channel for vulnerability reports.
