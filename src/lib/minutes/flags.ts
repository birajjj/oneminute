// Governance flagging for minutes.
//
// A minute can be flagged as a Governance point, a Decision, or a Scope item
// (ported from on-prem OneMinute). This module holds the pure helpers used to
// coerce free-text / AI-suggested flag values into the MinuteFlag enum, and to
// present them in the UI. Keeping it side-effect free makes it unit-testable
// and safe to import into both server and client components.

import { MINUTE_FLAGS, type MinuteFlagValue } from "@/types/schemas";

export { MINUTE_FLAGS };
export type { MinuteFlagValue };

// Case-insensitive lookup table so "decision", "DECISION", "Decision" all map
// to the canonical enum value.
const BY_LOWER = new Map<string, MinuteFlagValue>(
  MINUTE_FLAGS.map((f) => [f.toLowerCase(), f])
);

/**
 * Coerce an arbitrary flag string (AI output, form value, query param) into a
 * valid MinuteFlag, or null when it isn't one of the known flags / is blank.
 * The Gemini SDK can't express a nullable enum, so the planner emits "" for an
 * unflagged minute — this treats that (and any unrecognised value) as null.
 */
export function normalizeFlag(
  raw: string | null | undefined
): MinuteFlagValue | null {
  if (!raw) return null;
  return BY_LOWER.get(raw.trim().toLowerCase()) ?? null;
}

/** True when the value is one of the governance flags we track. */
export function isMinuteFlag(raw: unknown): raw is MinuteFlagValue {
  return typeof raw === "string" && BY_LOWER.has(raw.trim().toLowerCase());
}

// Small presentational metadata for badges/filters. Tailwind classes are kept
// here so the flag look is consistent everywhere it's rendered.
export const FLAG_BADGE_CLASS: Record<MinuteFlagValue, string> = {
  Governance: "bg-purple-100 text-purple-700",
  Decision: "bg-emerald-100 text-emerald-700",
  Scope: "bg-sky-100 text-sky-700"
};
