import React from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";

const SCHEDULE = [
  { time: "08:40 AM", what: "Check-in prompt · sampling day 6", status: "sent", note: "+2s" },
  { time: "10:00 AM", what: "Visit reminder · 3 days out", status: "sent", note: "+1s" },
  { time: "05:00 PM", what: "Monthly survey · follow-up 1", status: "sent", note: "+3s" },
  { time: "06:01 PM", what: "Check-in prompt · sampling day 6", status: "queued", note: "waiting" },
  { time: "07:36 PM", what: "Compensation notice", status: "queued", note: "waiting" },
];

const CAPABILITIES = [
  {
    title: "Momentary assessment",
    body: "Prompt grids delivered to the second across a sampling period. A prompt that cannot make its window is recorded as a protocol skip rather than sent at the wrong time.",
  },
  {
    title: "Recurring survey cycles",
    body: "Invite plus follow-up sequences computed from each participant's own anchor date, where the follow-ups stop the moment someone responds.",
  },
  {
    title: "Visit and retention reminders",
    body: "Anything expressible as \"n days after X, while Y is still incomplete\" — appointment reminders, between-visit questionnaires, re-engagement nudges.",
  },
  {
    title: "Compensation flows",
    body: "Payment notices with their own follow-up cadence and expiry warnings, conditional on whether the participant has claimed.",
  },
  {
    title: "Personal survey links",
    body: "Each message carries that participant's own link, resolved from the survey database at send time. A message whose link will not resolve is never sent.",
  },
  {
    title: "Tracking and audit",
    body: "A coordinator dashboard for completion status and upcoming sends, plus a daily reconciliation that surfaces anything planned but not accounted for.",
  },
];

const RAILS = [
  { name: "Append-only ledgers", text: "Every send is recorded per message, channel and recipient. Ledgers union-merge, so concurrent runs can never erase each other." },
  { name: "Send claims", text: "A sender claims a slot before transmitting. Two invocations racing the same moment resolve to exactly one message." },
  { name: "Provider arbitration", text: "Before a rescued or late send, the messaging provider is asked whether the message already arrived. Its history is the tiebreaker." },
  { name: "Quiet hours", text: "Nothing transmits outside the study's daily window, no matter when the scheduler wakes up." },
  { name: "Opt-outs, enforced twice", text: "A participant who asks to stop is excluded when the queue is built and again at the moment of sending." },
  { name: "Bounded catch-up", text: "Late messages deliver only within a defined window. Past it, the system records a skip — a prompt hours late is worse than none." },
  { name: "Kill switch", text: "One runtime flag drops the whole system to dry run without a deploy. Dry-run rows never satisfy \"already sent\"." },
  { name: "Link refusal", text: "An unresolved survey link is a hard stop. Participants never receive a message with a broken link in it." },
];

export default function Home(): JSX.Element {
  return (
    <Layout
      title="Scheduled outreach for research studies"
      description="TEMPO is a self-hosted server for studies that send scheduled surveys and reminders: momentary-assessment prompts, survey cycles, visit reminders and compensation notices, delivered on time and auditable afterward."
    >
      <header className="heroWrap">
        <div className="hero">
          <div>
            <div className="heroEyebrow">Open-source research software</div>
            <h1 className="heroTitle">TEMPO</h1>
            <div className="heroExpansion">
              Tracking, Engagement, Messaging &amp; Participant Outreach
            </div>
            <p className="heroLede">
              A self-hosted server for studies that send scheduled surveys and
              reminders. Declare what goes out and when; TEMPO works out who is
              owed what, delivers it by text and email at the right moment,
              refuses to send it twice, and keeps a record you can audit.
            </p>
            <div className="heroActions">
              <Link className="btn btnPrimary" to="/docs/intro">
                Read the documentation
              </Link>
              <Link className="btn btnGhost" to="/docs/quickstart">
                Quickstart
              </Link>
              <Link className="btn btnGhost" href="https://github.com/dzweben/tempo">
                GitHub
              </Link>
            </div>
          </div>

          <div className="scheduleCard" aria-label="Example of a study's send schedule">
            <div className="scheduleHead">
              <span>Today&apos;s sends</span>
              <span>study time</span>
            </div>
            {SCHEDULE.map((row) => (
              <div className="scheduleRow" key={row.time}>
                <span className="schedTime">{row.time}</span>
                <span className="schedWhat">{row.what}</span>
                <span
                  className={`schedStat ${row.status === "sent" ? "statSent" : "statQueued"}`}
                >
                  {row.status === "sent" ? `sent ${row.note}` : row.note}
                </span>
              </div>
            ))}
            <div className="scheduleFoot">
              Delivery latency is measured from the scheduled second, not from
              whenever the scheduler happened to wake up.
            </div>
          </div>
        </div>
      </header>

      <main>
        <section className="section">
          <div className="sectionHead">
            <div className="sectionKicker">The problem</div>
            <h2 className="sectionTitle">
              Studies run on dates. People do not.
            </h2>
            <p className="sectionLede">
              If your participants have dates attached to them — an enrollment
              date, a visit, a cycle start — and things must go out relative to
              those dates, conditionally, for months or years, then someone is
              currently doing that by hand. TEMPO is that person, except it does
              not forget, does not send twice, and writes down everything it did.
            </p>
          </div>

          <div className="grid">
            {CAPABILITIES.map((c) => (
              <div className="card" key={c.title}>
                <h3 className="cardTitle">{c.title}</h3>
                <p className="cardBody">{c.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="railBand">
          <div className="section">
            <div className="sectionHead">
              <div className="sectionKicker">Why it is careful</div>
              <h2 className="sectionTitle">
                Every rail here exists because something went wrong once.
              </h2>
              <p className="sectionLede">
                Messaging research participants is unforgiving: a duplicate text
                erodes trust, a prompt at the wrong hour contaminates the
                measurement, a silent failure costs data you cannot recover.
                At-most-once delivery is enforced three independent ways, because
                any one of them can be the thing that is down.
              </p>
            </div>
            <div className="railList">
              {RAILS.map((r) => (
                <div className="railItem" key={r.name}>
                  <h3 className="railName">{r.name}</h3>
                  <p className="railText">{r.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="sectionHead">
            <div className="sectionKicker">How it fits</div>
            <h2 className="sectionTitle">
              Your survey database stays the source of truth.
            </h2>
            <p className="sectionLede">
              TEMPO is not a survey platform and does not want to own your data.
              It reads your database on a schedule, works out what each
              participant is owed, sends it, and writes the result back as an
              auditable record. Completion status, survey links and participant
              records stay where they already live.
            </p>
          </div>
          <div className="grid">
            <div className="card">
              <h3 className="cardTitle">Declare, don&apos;t script</h3>
              <p className="cardBody">
                Every message is one row in a timeline spec: its condition, its
                send-date rule, its recipients, its template. Nothing else
                decides what goes out — which means the protocol is readable, and
                changing it does not mean changing code.
              </p>
            </div>
            <div className="card">
              <h3 className="cardTitle">Runs without a server</h3>
              <p className="cardBody">
                The dashboard and scheduled work deploy as serverless functions.
                There is no machine to keep alive, and no cron job on somebody&apos;s
                laptop that stops when they close it.
              </p>
            </div>
            <div className="card">
              <h3 className="cardTitle">Provable afterward</h3>
              <p className="cardBody">
                Snapshots and ledgers are versioned, so every state the study was
                in is recoverable. When a reviewer asks what participant 1042
                received in March, there is an answer.
              </p>
            </div>
          </div>
        </section>

        <section className="railBand">
          <div className="section closer">
            <h2 className="closerTitle">Built for a study like yours</h2>
            <p className="closerText">
              TEMPO is a reference implementation plus a reusable engine: you
              configure the timeline for your protocol and bind it to your
              database&apos;s fields. The documentation covers the whole path — from
              running it against example data in five minutes, to adapting it to
              a live study.
            </p>
            <div className="closerActions">
              <Link className="btn btnPrimary" to="/docs/intro">
                Start with the overview
              </Link>
              <Link className="btn btnGhost" to="/docs/adapting">
                Adapting it to your study
              </Link>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
