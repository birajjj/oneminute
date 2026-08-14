// Notes the app writes for itself when nothing actually happened. They are real
// entries (they record that an item was reviewed and left unchanged), but they
// must never become an item's headline description — otherwise a task's summary
// on the dashboard/board reads "No action this meeting."
const PLACEHOLDER_NOTES = new Set([
  "no action this meeting",
  "no action this meeting.",
  "no update",
  "no update.",
  "no action",
  "no action."
]);

export function isPlaceholderNote(s: string | null | undefined): boolean {
  if (!s || !s.trim()) return true;
  return PLACEHOLDER_NOTES.has(s.trim().toLowerCase());
}

// A written-out "nothing happened" note (the AI phrases these itself, so they
// aren't exact placeholders). An item whose latest note says this must never be
// presented as progress.
const NO_PROGRESS = /\bno\s+(?:further\s+|significant\s+)?(?:progress|update|updates|action|change|changes|movement)\b/i;

export function describesNoProgress(s: string | null | undefined): boolean {
  if (isPlaceholderNote(s)) return true;
  return NO_PROGRESS.test(s as string);
}

/** The newest entry carrying a real note, ignoring placeholders. */
export function pickLatestNote<T>(
  entries: T[],
  getNote: (e: T) => string | null
): T | undefined {
  return entries.find((e) => !isPlaceholderNote(getNote(e)));
}
