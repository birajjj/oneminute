"use client";

import { useState } from "react";
import { MINUTE_TAGS, TAG_STYLES } from "@/lib/tags";

/**
 * Governance flags on a minute. Click to toggle.
 *
 * By default only the flags actually SET are shown, with a small ⚑ to reveal the
 * rest. Showing all three on every row meant a 20-item meeting rendered 60 chips,
 * most of them meaningless — the noise buried the flags that did mean something.
 *
 * `showAll` opts out, for the sidebar filter where all three ARE the control:
 * you cannot pick a flag to filter by if it isn't on screen.
 */
export function TagChips({
  value,
  onChange,
  disabled,
  showAll = false
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  showAll?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = showAll || expanded;

  function toggle(tag: string) {
    onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag]);
  }

  // Which chips to render: everything when open, otherwise only what's set.
  const visible = open ? [...MINUTE_TAGS] : MINUTE_TAGS.filter((t) => value.includes(t));

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((tag) => {
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
              // A ring + full colour marks what's set, so the distinction never
              // rests on opacity alone.
              on ? "opacity-100 ring-1 ring-current" : "opacity-60 hover:opacity-100"
            } disabled:cursor-not-allowed`}
            title={on ? `Remove ${tag} flag` : `Flag as ${tag}`}
          >
            {tag}
          </button>
        );
      })}

      {!showAll && !disabled && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="rounded-full px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          title={expanded ? "Hide unused flags" : "Add a flag"}
          aria-label={expanded ? "Hide unused flags" : "Add a flag"}
        >
          {expanded ? "×" : "⚑"}
        </button>
      )}
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
