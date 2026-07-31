"use client";

import { useMemo, useState } from "react";

export interface ProjectFilterOption {
  id: string;
  name: string;
}

export default function ProjectFilterDropdown({
  projects,
  value,
  onChange,
  className = ""
}: {
  projects: ProjectFilterOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedName = useMemo(() => {
    if (value === "all") return "All Projects";
    return projects.find((p) => p.id === value)?.name ?? "All Projects";
  }, [projects, value]);

  function choose(next: string) {
    onChange(next);
    setOpen(false);
  }

  return (
    <div className={`relative ${className}`} onBlur={() => setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded border border-slate-300 bg-white px-2 py-1.5 text-left text-sm"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selectedName}
      >
        <span className="min-w-0 truncate">{selectedName}</span>
        <span className="shrink-0 text-slate-500">v</span>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-[calc(100%+0.25rem)] z-30 max-h-72 w-full overflow-y-auto rounded border border-slate-300 bg-white py-1 text-sm shadow-lg"
        >
          <DropdownOption
            label="All Projects"
            selected={value === "all"}
            onChoose={() => choose("all")}
          />
          {projects.map((p) => (
            <DropdownOption
              key={p.id}
              label={p.name}
              selected={value === p.id}
              onChoose={() => choose(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DropdownOption({
  label,
  selected,
  onChoose
}: {
  label: string;
  selected: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onChoose}
      className={`block w-full truncate px-3 py-1.5 text-left ${
        selected ? "bg-brand-blue text-white" : "text-slate-900 hover:bg-slate-100"
      }`}
      title={label}
    >
      {label}
    </button>
  );
}
