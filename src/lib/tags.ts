// Governance flags on a minute — carried over from on-prem OneMinute, where they
// were a comma-joined `Tags` string with the same three values. A minute can
// carry any combination (or none).
//
// Kept as strings rather than a Prisma enum so a fourth flag can be added here
// without a schema migration; everything written goes through normalizeTags(),
// so a typo or an AI hallucination can never reach the database.
//
// Safe to import from client components.

export const MINUTE_TAGS = ["Decision", "Scope", "Governance"] as const;
export type MinuteTag = (typeof MINUTE_TAGS)[number];

/** Tailwind classes per tag, so a flag looks the same everywhere it appears. */
export const TAG_STYLES: Record<string, string> = {
  Decision: "bg-violet-100 text-violet-700 border-violet-300",
  Scope: "bg-amber-100 text-amber-700 border-amber-300",
  Governance: "bg-sky-100 text-sky-700 border-sky-300"
};

/** Keep only known flags, case-insensitively, de-duplicated and in a stable order. */
export function normalizeTags(input: unknown): MinuteTag[] {
  const raw: string[] = Array.isArray(input)
    ? input.map(String)
    : typeof input === "string"
      ? input.split(",") // tolerate on-prem's comma-joined form
      : [];

  const seen = new Set<MinuteTag>();
  for (const item of raw) {
    const match = MINUTE_TAGS.find((t) => t.toLowerCase() === item.trim().toLowerCase());
    if (match) seen.add(match);
  }
  return MINUTE_TAGS.filter((t) => seen.has(t));
}
