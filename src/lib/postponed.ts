// Participants whose reminders are postponed — they are skipped from sends
// but still visible on the dashboard with a POSTPONED badge.
// Resume date is TBD; coordinator will indicate when to remove from this list.
export const POSTPONED_SUBIDS = new Set<string>([
  // Add subIds here to skip their reminders and show a POSTPONED badge.
  // Lowercase only. Example: "s1234".
]);

export function isPostponed(subId: string): boolean {
  return POSTPONED_SUBIDS.has(subId.toLowerCase());
}
