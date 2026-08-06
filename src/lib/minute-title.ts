// A minute is worth saving if it has a title OR a description. When the title is
// missing we derive a short one from the description so the row still displays.
// Both empty → not a real minute (dropped by the caller).

export function hasContent(title: string | null | undefined, description: string | null | undefined): boolean {
  return !!(title && title.trim()) || !!(description && description.trim());
}

export function deriveTitle(desc: string | null | undefined): string {
  const d = (desc || "").trim();
  if (!d) return "";
  return d.length <= 70 ? d : d.slice(0, 67).trimEnd() + "…";
}

// The title to store: the given one, else derived from the description.
export function titleOrDerived(
  title: string | null | undefined,
  description: string | null | undefined
): string {
  const t = (title || "").trim();
  return t || deriveTitle(description);
}
