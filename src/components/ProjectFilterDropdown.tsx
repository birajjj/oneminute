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
  onDeleteProject,
  className = ""
}: {
  projects: ProjectFilterOption[];
  value: string;
  onChange: (value: string) => void;
  // When provided, each project row shows a hover trash icon that calls this.
  onDeleteProject?: (project: ProjectFilterOption) => void;
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
              onDelete={
                onDeleteProject
                  ? () => { setOpen(false); onDeleteProject(p); }
                  : undefined
              }
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
  onChoose,
  onDelete
}: {
  label: string;
  selected: boolean;
  onChoose: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={`group flex items-center ${
        selected ? "bg-brand-blue" : "hover:bg-slate-100"
      }`}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onChoose}
        className={`min-w-0 flex-1 truncate px-3 py-1.5 text-left ${
          selected ? "text-white" : "text-slate-900"
        }`}
        title={label}
      >
        {label}
      </button>
      {onDelete && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className={`shrink-0 px-2 py-1.5 text-xs opacity-0 transition group-hover:opacity-100 ${
            selected ? "text-white/80 hover:text-white" : "text-slate-400 hover:text-red-600"
          }`}
          title={`Delete project “${label}”`}
          aria-label={`Delete project ${label}`}
        >
          🗑
        </button>
      )}
    </div>
  );
}
