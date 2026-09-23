// TIMELINE SPEC — the primary configuration surface of TEMPO.
//
// Every automated message a study sends is declared as one row here:
// when it fires, who it goes to, on which channels, under what condition,
// and what it says. Nothing else in the codebase decides what gets sent.
//
// The entries below are a SYNTHETIC EXAMPLE for a fictional study. They
// demonstrate each supported message kind and the shape of a real spec —
// they are not a runnable protocol. Replace them with your own.
//
// Production deployments typically generate this file from a spreadsheet
// the study coordinators maintain, so message wording and cadence stay
// with the people who own the protocol rather than living in code.
//
// FIELD REFERENCE
//   condition       Survey-database logic deciding whether the message is
//                   owed at all (e.g. only while the survey is incomplete).
//   sendDateSpec    A date field in the database, optionally with a cadence
//                   clause ("3 days after ... repeat every 3 days up to 2
//                   times"), resolved per participant by the pipeline.
//   destinationSpec [event][field] references to the contact fields to use.
//                   Channels are parsed from these: phone fields imply SMS,
//                   email fields imply email.
//   emaKey          For momentary-assessment prompts only: the slot key
//                   (weekday + clock time) within the prompt grid.
//   message         Template body. [event][field] placeholders are filled
//                   per participant; [event][survey-link:instrument] is
//                   replaced with that participant's personal survey URL,
//                   resolved at send time.

import type { Channel, WaveYear } from "@/types";

export type AlertKind =
  | "athome_sms"
  | "athome_email"
  | "sts1_invite"
  | "sts1_followup"
  | "sts2_invite"
  | "sts2_followup"
  | "ema_enable"
  | "ema_prompt"
  | "payment_email"
  | "payment_followup"
  | "payment_expire"
  | "other";

export interface TimelineAlert {
  alertId: number;
  wave: WaveYear;
  kind: AlertKind;
  instrument: string;
  trigger: string | null;
  condition: string | null;
  sendDateSpec: string | null;
  destinationSpec: string | null;
  channels: Channel[];
  emaKey: string | null;
  message: string | null;
}

function parseChannels(spec: string | null): Channel[] {
  if (!spec) return [];
  const s = spec.toLowerCase();
  const out: Channel[] = [];
  if (s.includes("phone")) out.push("sms");
  if (s.includes("email")) out.push("email");
  return out;
}

const CONTACTS = "[enrollment_arm_1][phone_primary]; [enrollment_arm_1][phone_secondary]\t[email]";

const RAW: Omit<TimelineAlert, "channels">[] = [
  // --- Recurring survey cycle: invite, then two follow-ups -------------
  {
    alertId: 1,
    wave: 1 as WaveYear,
    kind: "sts1_invite",
    instrument: "Monthly Survey Invite 1.1",
    trigger: null,
    condition: "[survey_y1_arm_1][monthly_1_complete]<>2",
    sendDateSpec: "[survey_y1_arm_1][monthly_1_date]",
    destinationSpec: CONTACTS,
    emaKey: null,
    message:
      "Hi [enrollment_arm_1][first_name], it's time for your monthly survey for the Example Study. It takes about 10 minutes: [survey_y1_arm_1][survey-link:monthly_1]",
  },
  {
    alertId: 2,
    wave: 1 as WaveYear,
    kind: "sts1_followup",
    instrument: "Monthly Survey Follow-up 1.1",
    trigger: null,
    // Follow-ups stop queueing the moment the survey is completed.
    condition: "[survey_y1_arm_1][monthly_1_complete]<>2",
    sendDateSpec:
      "3 days after [survey_y1_arm_1][monthly_1_date] repeat every 3 days up to 2 times",
    destinationSpec: CONTACTS,
    emaKey: null,
    message:
      "Hi [enrollment_arm_1][first_name], a reminder that your Example Study monthly survey is still open: [survey_y1_arm_1][survey-link:monthly_1]",
  },

  // --- At-home measures: one SMS, one email ---------------------------
  {
    alertId: 3,
    wave: 1 as WaveYear,
    kind: "athome_sms",
    instrument: "At-Home Measures",
    trigger: "[visit_1_y1_arm_1][timestamp_athome]",
    condition: "[visit_1_y1_arm_1][athome_complete]<>2",
    sendDateSpec: "[visit_1_y1_arm_1][timestamp_athome]",
    destinationSpec: "[enrollment_arm_1][phone_primary]",
    emaKey: null,
    message:
      "Thanks for visiting us today! Here are your at-home questionnaires: [visit_1_y1_arm_1][survey-link:athome]",
  },
  {
    alertId: 4,
    wave: 1 as WaveYear,
    kind: "athome_email",
    instrument: "At-Home Measures",
    trigger: "[visit_1_y1_arm_1][timestamp_athome]",
    condition: "[visit_1_y1_arm_1][athome_complete]<>2",
    sendDateSpec: "[visit_1_y1_arm_1][timestamp_athome]",
    destinationSpec: "[enrollment_arm_1][email]",
    emaKey: null,
    message:
      "Hi [enrollment_arm_1][first_name],\n\nThanks for coming in today. Your at-home questionnaires are ready here: [visit_1_y1_arm_1][survey-link:athome]\n\n— The Example Study Team",
  },

  // --- Momentary assessment (EMA): enable prompt, then grid prompts ----
  {
    alertId: 5,
    wave: 1 as WaveYear,
    kind: "ema_enable",
    instrument: "EMA Settings",
    trigger: null,
    condition: "[checkin_arm_1][checkin_enabled]=''",
    // Fires a few days before the cycle's start day so the participant can
    // opt in and pick a contact number first.
    sendDateSpec: "3 days 8 hours before [checkin_arm_1][checkin_start_day]",
    destinationSpec: CONTACTS,
    emaKey: null,
    message:
      "Hi [enrollment_arm_1][first_name], your Example Study check-in period starts soon. Tap here to confirm the number we should text: [checkin_arm_1][survey-link:checkin_settings]",
  },
  {
    alertId: 6,
    wave: 1 as WaveYear,
    kind: "ema_prompt",
    instrument: "Check-in 1",
    trigger: null,
    condition: "[checkin_arm_1][checkin_1_complete]<>2",
    sendDateSpec: "[checkin_arm_1][checkin_start_day]",
    destinationSpec: "[checkin_arm_1][prompt_phone]",
    // Slot key: weekday + clock time within the prompt grid. A real study
    // defines one entry per slot (commonly 20-30 across a cycle).
    emaKey: "ema_mon_1000",
    message:
      "Hi [enrollment_arm_1][first_name]! Time for a quick check-in — it takes about a minute: [checkin_arm_1][survey-link:checkin_1]",
  },
  {
    alertId: 7,
    wave: 1 as WaveYear,
    kind: "ema_prompt",
    instrument: "Check-in 2",
    trigger: null,
    condition: "[checkin_arm_1][checkin_2_complete]<>2",
    sendDateSpec: "[checkin_arm_1][checkin_start_day]",
    destinationSpec: "[checkin_arm_1][prompt_phone]",
    emaKey: "ema_mon_1600",
    message:
      "Hi [enrollment_arm_1][first_name]! Time for a quick check-in — it takes about a minute: [checkin_arm_1][survey-link:checkin_2]",
  },

  // --- Compensation: notice, follow-up, expiry ------------------------
  {
    alertId: 8,
    wave: 1 as WaveYear,
    kind: "payment_email",
    instrument: "Compensation",
    trigger: null,
    condition: "[payment_y1_arm_1][payment_claimed]<>1",
    sendDateSpec: "5 days after [payment_y1_arm_1][payment_ready_date]",
    destinationSpec: "[enrollment_arm_1][email]",
    emaKey: null,
    message:
      "Hi [enrollment_arm_1][first_name],\n\nYour compensation for completing this phase of the Example Study is ready to claim here: [payment_y1_arm_1][survey-link:payment]\n\n— The Example Study Team",
  },
  {
    alertId: 9,
    wave: 1 as WaveYear,
    kind: "payment_followup",
    instrument: "Compensation",
    trigger: null,
    condition: "[payment_y1_arm_1][payment_claimed]<>1",
    sendDateSpec:
      "14 days after [payment_y1_arm_1][payment_ready_date] repeat every 14 days up to 4 times",
    destinationSpec: "[enrollment_arm_1][email]",
    emaKey: null,
    message:
      "Hi [enrollment_arm_1][first_name],\n\nA reminder that your Example Study compensation is still waiting: [payment_y1_arm_1][survey-link:payment]\n\n— The Example Study Team",
  },
  {
    alertId: 10,
    wave: 1 as WaveYear,
    kind: "payment_expire",
    instrument: "Compensation",
    trigger: null,
    condition: "[payment_y1_arm_1][payment_claimed]<>1",
    sendDateSpec: "90 days after [payment_y1_arm_1][payment_ready_date]",
    destinationSpec: "[enrollment_arm_1][email]",
    emaKey: null,
    message:
      "Hi [enrollment_arm_1][first_name],\n\nYour Example Study compensation link expires in one week: [payment_y1_arm_1][survey-link:payment]\n\n— The Example Study Team",
  },
];

export const TIMELINE_ALERTS: TimelineAlert[] = RAW.map((a) => ({
  ...a,
  channels: parseChannels(a.destinationSpec),
}));

export function alertsForWave(wave: WaveYear): TimelineAlert[] {
  return TIMELINE_ALERTS.filter((a) => a.wave === wave);
}

export function alertById(alertId: number, wave: WaveYear): TimelineAlert | undefined {
  return TIMELINE_ALERTS.find((a) => a.alertId === alertId && a.wave === wave);
}

export function alertsForRuntimeWave(wave: WaveYear): TimelineAlert[] {
  return alertsForWave(wave);
}
