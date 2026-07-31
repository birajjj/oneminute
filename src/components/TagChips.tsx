"use client";

import { MINUTE_TAGS, TAG_STYLES } from "@/lib/tags";

/**
 * Governance flags on a minute. Mirrors on-prem OneMinute's chips: click to
 * toggle, unselected sits at reduced opacity so all three stay discoverable.
 */
export function TagChips({
  value,
  onChange,
  disabled
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  function toggle(tag: string) {
    onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag]);
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {MINUTE_TAGS.map((tag) => {
        const on = value.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            disabled={disabled}
            onClick={() => toggle(tag)}
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
              TAG_STYLES[tag]
            } ${
              // Unselected stays legible; a ring + full colour marks what's set,
              // so the distinction doesn't rely on opacity alone.
              on ? "opacity-100 ring-1 ring-current" : "opacity-75 hover:opacity-100"
            } disabled:cursor-not-allowed`}
            title={on ? `Remove ${tag} flag` : `Flag as ${tag}`}
          >
            {tag}
          </button>
        );
      })}
    </div>
  );
}

/** Read-only rendering — only the flags actually set. */
export function TagBadges({ tags }: { tags: string[] }) {
  if (!tags || tags.length === 0) return null;
  return (
    <>
      {tags.map((tag) => (
        <span
          key={tag}
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            TAG_STYLES[tag] ?? "bg-slate-100 text-slate-600 border-slate-300"
          }`}
        >
          {tag}
        </span>
      ))}
    </>
  );
}
