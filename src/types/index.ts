// Data model.
//
// One object per participant, assembled from the survey platform export.
// The event and field names a deployment reads are bound in
// scripts/fetch-data.mjs; everything below is the shape that binding
// produces. Wave/cycle/prompt structures are the reference protocol's
// shape — adjust them to your own.
//

export type WaveYear = 1 | 2 | 3;
export type Channel = "sms" | "email";

// REDCap completion code: 0=incomplete, 1=unverified, 2=complete
export type CompletionCode = 0 | 1 | 2;

// ---------- Participant ----------

export interface ContactInfo {
  firstName: string;
  lastName: string;
  parentName: string;
  email: string;
  phonePrimary: string;
  phoneSecondary: string;
  childPhone: string;
  // Comma-separated cohort label from the Session Notes sheet: "1000" | "2000" | "3000".
  cohortGroup: string;
  // Computed from REDCap `dob` when available, falling back to self-report.
  // Used to gate 13+ instruments (EMA, payment variant). null when neither
  // dob nor age is on file.
  dob: string | null;
  age: number | null;
}

export interface AtHomeStatus {
  timestamp: string | null;       // [visit_1_y{N}_arm_1][timestamp_athome] — set when in-lab break_1 hits 2
  break1Complete: CompletionCode; // gates the at-home send
  athomeMeasuresComplete: CompletionCode;
  // Every <something>_complete code surfaced from the per-wave at-home
  // REDCap report (per wave). Lets the dashboard show generic
  // section-by-section completion without hard-coding instrument names.
  formsFromReport?: Record<string, CompletionCode>;
  // Headline counts derived from formsFromReport for quick rendering.
  sectionsComplete?: number;
  sectionsTotal?: number;
}

export interface STSCycle {
  index: number;                  // 1-based: 1.1, 1.2 … or 2.1, 2.2 …
  date: string | null;            // scheduled send date from REDCap (date-only YYYY-MM-DD)
  complete: CompletionCode;       // 0/1/2
  surveyLink: string | null;
}

export interface STSStatus {
  active: boolean;                  cycles: STSCycle[];             // STS1: 6 entries, STS2: 3 entries
}

export interface EMAPrompt {
  key: string;                    // slot key, e.g. "mon_0734"
  dayLabel: string;               // "Monday 1", "Tuesday 1", …
  timeLabel: string;              // "7:34 AM", …
  scheduledAt: string | null;     // ISO datetime from REDCap (or null if not yet computed)
  complete: boolean;              // we infer from the survey completion field
}

export interface EMAStatus {
  active: boolean;                // ema_cycle == "1"
  startDay: string | null;        // ema_start_day
  startDayCalc: number | null;    // ema_start_day_calc
  enableSent: boolean;            // tracked client-side via sent-log
  phone: string;                  // ema_phone (which line to text for EMA)
  prompts: EMAPrompt[];           // ~20 timed prompts per cycle
  // Non-prompt _complete codes surfaced from the per-wave EMA report.
  formsFromReport?: Record<string, CompletionCode>;
  // Aggregate prompt counts for headline rendering on the dashboard.
  promptsCompleteCount?: number;
  promptsScheduledCount?: number;
  promptsTotal?: number;
  // Rolling-Monday tracking fields surfaced from the EMA event.
  startDayCalcSum?: number;
  enableConfirmed?: boolean;
  settingsComplete?: CompletionCode;
  paymentEmailButton?: boolean;
  paymentComplete?: CompletionCode;
}

export interface VisitStatus {
  date: string | null;
  // Per-form completion codes for the rich V1/V2 instruments.
  forms: Record<string, CompletionCode>;
  allComplete: boolean;
}

// Per-participant per-wave row pulled directly from the team-maintained
// Follow up.{N} Google Sheet. This is the source of truth for V1/V2
// completion (and the human-friendly month-labels for STS sends) until
// REDCap exposes the corresponding fields.
export interface FollowupSheetRow {
  record?: string | number | null;
  v2Date?: string | number | null;          // "Visit 2" date — V2 done if filled
  sts1Months?: (string | number | null)[];  // 6 entries — month/year labels for STS1.1..1.6
  sts2Months?: (string | number | null)[];  // 3 entries
  emaDate?: string | number | null;
  emaStatus?: string | null;                // e.g. "COMPLETE"
  w1Comp?: string | number | null;
  w2Comp?: string | number | null;
  wave2StartDate?: string | number | null;
  wave3StartDate?: string | number | null;
  raTag?: string | null;
  notes?: string | null;
}

export interface WaveStatus {
  year: WaveYear;
  // null if the participant hasn't started this wave yet.
  v1: VisitStatus | null;
  atHome: AtHomeStatus | null;
  sts1: STSStatus | null;
  sts2: STSStatus | null;
  ema: EMAStatus | null;
  v2: VisitStatus | null;
  // Source-of-truth tracker pulled from the Google Sheet (Follow up.{year}).
  followupSheet?: FollowupSheetRow;
}

export interface Participant {
  pid: string;                    // study-facing ID, e.g. "1001"
  recordId: string;               // REDCap record_id
  contact: ContactInfo;
  // Wave-by-wave participation. Keys: 1, 2, 3.
  waves: Partial<Record<WaveYear, WaveStatus>>;
  // Current active wave (the highest year with an open V1).
  activeWave: WaveYear | null;
}

// ---------- Reminders (the outgoing queue) ----------

// Each "due reminder" is a single (participant, alert) tuple that the
// 5-min poller resolves into outbound messages.
export interface DueReminder {
  id: string;                        // hash of (pid|alertId|scheduledAt) — idempotency key
  pid: string;
  recordId: string;
  alertId: number;                   // matches "Alert #" in the Timeline spreadsheet
  instrument: string;                // e.g. "Screen Time Auto Invite 1.1"
  wave: WaveYear;
  scheduledAt: string;               // ISO datetime — when this is supposed to fire
  channels: Channel[];               // ["sms"], ["email"], or both
  recipientPhones: string[];         // E.164 strings ready for OpenPhone
  recipientEmail: string | null;
  subject: string | null;            // null when channel is sms-only
  messageBody: string;               // already substituted, ready to send
  // What survey-link substitution the body needs (resolved at send-time):
  surveyLinkSlot: {
    eventName: string;
    instrument: string;
  } | null;
}

export interface SentLogEntry {
  id: string;                        // matches DueReminder.id
  timestamp: string;                 // ISO when we actually sent
  pid: string;
  alertId: number;
  instrument: string;
  channel: Channel;
  recipient: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
}

// ---------- Dashboard rollups ----------

export interface DashboardStats {
  totalParticipants: number;
  // Per-wave count of participants who appear in that wave.
  // NOTE: byWave is NOT the denominator for cross-wave completion ratios.
  // The denominator for V1/V2/STS/EMA/at-home cross-wave ratios is
  // `totalParticipants`.
  byWave: Record<WaveYear, number>;
  // Per-wave completion counts for the marquee numbers on Overview.
  v1Complete: Record<WaveYear, number>;
  atHomeComplete: Record<WaveYear, number>;  // >= 7 of 8 sections
  // Single consolidated STS count: >= 5 of 9 surveys (STS1 6 + STS2 3) done.
  stsComplete: Record<WaveYear, number>;
  // EMA count: >= 10 of 25 prompts complete.
  emaComplete: Record<WaveYear, number>;
  emaActive: Record<WaveYear, number>;
  v2Complete: Record<WaveYear, number>;
  // Today's outgoing count by channel.
  remindersToday: { sms: number; email: number };
}

export interface STSGridRow {
  pid: string;
  wave: WaveYear;
  active: boolean;
  cycles: STSCycle[];
  allComplete: boolean;
  totalComplete: number;
  totalCycles: number;
}

export interface EMAGridRow {
  pid: string;
  wave: WaveYear;
  active: boolean;
  startDay: string | null;
  totalPrompts: number;
  promptsSent: number;
  promptsComplete: number;
}
