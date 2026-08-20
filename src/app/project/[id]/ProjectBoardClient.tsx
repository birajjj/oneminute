"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TagBadges } from "@/components/TagChips";
import { MINUTE_TAGS, TAG_STYLES } from "@/lib/tags";
import StyleProfilePanel from "@/components/StyleProfilePanel";

export interface BoardThreadEntry {
  id: string;
  isRoot: boolean;
  description: string | null;
  status: string;
  date: string; // ISO
  meetingTitle: string;
}

export interface BoardItem {
  id: string;
  // Latest entry in the thread — status edits target this (it's the status the
  // board displays); type/owner/due are item identity and target `id` (the root).
  latestEntryId: string;
  rootMeetingId: string;
  area: string;
  title: string;
  description: string | null;
  type: string; // label
  status: string; // current, label
  assignedTo: string | null;
  dueDate: string | null; // ISO
  tags: string[];
  devopsItemId: number | null;
  updateCount: number;
  raisedFromRootId: string | null;
  raisedFromTitle: string | null;
  lastActivity: string; // ISO
  meetingIds: string[]; // every meeting this item's thread touches
  thread: BoardThreadEntry[];
}

const TYPE_BADGE: Record<string, string> = {
  Note: "bg-slate-100 text-slate-600",
  "To-Do": "bg-blue-100 text-blue-700",
  Action: "bg-emerald-100 text-emerald-700",
  Devops: "bg-orange-100 text-orange-700"
};

const STATUS_BADGE: Record<string, string> = {
  New: "bg-slate-100 text-slate-600",
  Initiated: "bg-indigo-100 text-indigo-700",
  "In Progress": "bg-blue-100 text-blue-700",
  Resolved: "bg-teal-100 text-teal-700",
  Closed: "bg-emerald-100 text-emerald-700",
  Cancelled: "bg-slate-200 text-slate-500"
};

// A coloured left edge per status — used in the default "All meetings" view.
const STATUS_ACCENT: Record<string, string> = {
  New: "border-l-slate-300",
  Initiated: "border-l-indigo-400",
  "In Progress": "border-l-blue-500",
  Resolved: "border-l-teal-500",
  Closed: "border-l-emerald-500",
  Cancelled: "border-l-slate-300"
};

// Lifecycle order, so "Sort by status" groups items in a sensible progression
// rather than alphabetically.
const STATUS_RANK: Record<string, number> = {
  New: 0,
  Initiated: 1,
  "In Progress": 2,
  Resolved: 3,
  Closed: 4,
  Cancelled: 5
};

const TYPE_OPTIONS = ["To-Do", "Devops", "Action", "Note"];
const STATUS_OPTIONS = ["New", "Initiated", "In Progress", "Resolved", "Closed", "Cancelled"];

function isOpen(status: string) {
  return status !== "Closed" && status !== "Cancelled";
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ISO (or a plain "YYYY-MM-DD") -> the value a <input type="date"> expects. Due
// dates are stored at UTC midnight, so the first 10 chars are the intended day
// with no timezone drift.
function toDateInput(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

// A filter dropdown that allows picking several values at once (checkboxes),
// so the board can be narrowed to e.g. To-Do + Action, or two owners together.
// Empty selection = no filter (shows the neutral label).
function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);
  const summary =
    selected.length === 0
      ? label
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label ?? selected[0]
        : `${label} · ${selected.length}`;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded-md border px-2 py-1 text-sm ${
          selected.length
            ? "border-brand-blue bg-blue-50 text-brand-blue"
            : "border-slate-300 text-slate-700 hover:bg-slate-50"
        }`}
      >
        {summary}
        <span className="text-[10px] text-slate-400">▾</span>
      </button>
      {open && (
        <>
          {/* Click-away backdrop. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute left-0 z-20 mt-1 max-h-64 min-w-[190px] overflow-y-auto rounded-md border border-slate-200 bg-white p-1 shadow-lg">
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="mb-1 w-full rounded px-2 py-1 text-left text-xs text-slate-500 hover:bg-slate-100"
              >
                Clear selection
              </button>
            )}
            {options.map((o) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-slate-700 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  onChange={() => toggle(o.value)}
                />
                {o.label}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function isOverdue(item: BoardItem) {
  if (!item.dueDate || !isOpen(item.status)) return false;
  const due = new Date(item.dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

// How long an item has sat untouched — with 60+ open items, this is what tells
// a live item apart from one nobody has mentioned since July.
const STALE_DAYS = 14;
function daysSince(iso: string) {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - d.getTime()) / 86_400_000);
}
function agoLabel(days: number) {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export default function ProjectBoardClient({
  project,
  items: initialItems,
  areas,
  meetings,
  members,
  userName
}: {
  project: { id: string; name: string };
  items: BoardItem[];
  areas: string[];
  meetings: { id: string; title: string; date: string }[];
  members: string[];
  userName: string;
}) {
  // Local copy so inline edits reflect immediately; re-synced whenever the
  // server sends fresh data (after a router.refresh()).
  const [items, setItems] = useState<BoardItem[]>(initialItems);
  useEffect(() => setItems(initialItems), [initialItems]);
  const [activeTab, setActiveTab] = useState<string>("All");
  const [statusFilter, setStatusFilter] = useState<"open" | "closed" | "all">("open");
  // Multi-select: empty = no filter. Type holds labels; assignee holds display
  // names plus the sentinel "__unassigned".
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([]);
  const [meetingFilter, setMeetingFilter] = useState<string>("all");
  const [flagFilter, setFlagFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"activity" | "stale" | "due" | "title" | "status">("activity");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [openItem, setOpenItem] = useState<BoardItem | null>(null);
  // Which row's due-date picker is open (an undated item shows "+ due date").
  const [dateOpen, setDateOpen] = useState<string | null>(null);
  // Bulk edit: tick rows, then apply one change to all of them.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const router = useRouter();

  // Edit an item inline on a row. Status is point-in-time (it's the latest
  // entry's, which is what the board shows), so it saves to the latest entry;
  // type/owner/due are the item's identity and save to the root. Optimistic,
  // then re-synced from the server.
  async function editItem(
    item: BoardItem,
    field: "status" | "type" | "assignedTo" | "dueDate" | "area",
    value: string
  ) {
    const targetId = field === "status" ? item.latestEntryId : item.id;
    const patch: Record<string, string> = { [field]: value };
    const apply = (i: BoardItem): BoardItem => {
      if (field === "status") return { ...i, status: value };
      if (field === "type") return { ...i, type: value };
      if (field === "assignedTo") return { ...i, assignedTo: value || null };
      if (field === "area") return { ...i, area: value };
      return { ...i, dueDate: value || null };
    };
    // Optimistic: update the list (and the open panel if it's this item).
    setItems((prev) => prev.map((i) => (i.id === item.id ? apply(i) : i)));
    setOpenItem((prev) => (prev && prev.id === item.id ? apply(prev) : prev));
    try {
      const res = await fetch(`/api/minutes/${targetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Save failed");
      }
      router.refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
      router.refresh(); // fall back to server truth
    }
  }

  function toggleFlag(tag: string) {
    setFlagFilter((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }

  // Count per area for the tab bar (respects only the current status filter so the
  // numbers track what a click would reveal, not the whole project).
  const areaCounts = useMemo(() => {
    const counts: Record<string, number> = { All: 0 };
    for (const a of areas) counts[a] = 0;
    for (const it of items) {
      const passStatus =
        statusFilter === "all"
          ? true
          : statusFilter === "open"
            ? isOpen(it.status)
            : it.status === "Closed";
      if (!passStatus) continue;
      counts.All += 1;
      counts[it.area] = (counts[it.area] ?? 0) + 1;
    }
    return counts;
  }, [items, areas, statusFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = items.filter((it) => {
      if (activeTab !== "All" && it.area !== activeTab) return false;
      if (statusFilter === "open" && !isOpen(it.status)) return false;
      if (statusFilter === "closed" && it.status !== "Closed") return false;
      if (typeFilter.length && !typeFilter.includes(it.type)) return false;
      if (assigneeFilter.length) {
        const matches =
          (it.assignedTo && assigneeFilter.includes(it.assignedTo)) ||
          (!it.assignedTo && assigneeFilter.includes("__unassigned"));
        if (!matches) return false;
      }
      if (overdueOnly && !isOverdue(it)) return false;
      // Meeting filter: show items whose thread was touched in the chosen meeting.
      if (meetingFilter !== "all" && !it.meetingIds.includes(meetingFilter)) return false;
      // OR across flags: an item shows if it carries ANY selected flag (clicking
      // more flags widens the list), matching the Browse flag filter.
      if (flagFilter.length && !it.tags.some((t) => flagFilter.includes(t))) return false;
      if (q) {
        const hay = `${it.title} ${it.assignedTo ?? ""} ${it.thread
          .map((e) => e.description ?? "")
          .join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list = list.slice().sort((a, b) => {
      switch (sort) {
        case "due": {
          const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
          const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
          return ad - bd;
        }
        case "stale": // longest untouched first
          return new Date(a.lastActivity).getTime() - new Date(b.lastActivity).getTime();
        case "title":
          return a.title.localeCompare(b.title);
        case "status": {
          // Lifecycle order; within the same status, most-recently-touched first.
          const ar = STATUS_RANK[a.status] ?? 99;
          const br = STATUS_RANK[b.status] ?? 99;
          if (ar !== br) return ar - br;
          return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
        }
        case "activity":
        default:
          return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      }
    });
    return list;
  }, [items, activeTab, statusFilter, typeFilter, assigneeFilter, meetingFilter, flagFilter, search, sort, overdueOnly]);

  // Summary strip across the WHOLE project (independent of filters), so the boss
  // always sees the true totals.
  const summary = useMemo(() => {
    let open = 0,
      done = 0,
      cancelled = 0,
      overdue = 0,
      noOwner = 0,
      noDue = 0;
    for (const it of items) {
      if (it.status === "Closed") done += 1;
      else if (it.status === "Cancelled") cancelled += 1;
      else {
        open += 1;
        if (isOverdue(it)) overdue += 1;
        if (!it.assignedTo) noOwner += 1;
        if (!it.dueDate) noDue += 1;
      }
    }
    return { total: items.length, open, done, cancelled, overdue, noOwner, noDue };
  }, [items]);

  const activeFilterCount =
    (statusFilter !== "open" ? 1 : 0) +
    (typeFilter.length ? 1 : 0) +
    (assigneeFilter.length ? 1 : 0) +
    (meetingFilter !== "all" ? 1 : 0) +
    (overdueOnly ? 1 : 0) +
    flagFilter.length +
    (search.trim() ? 1 : 0);

  function clearFilters() {
    setStatusFilter("open");
    setTypeFilter([]);
    setAssigneeFilter([]);
    setMeetingFilter("all");
    setFlagFilter([]);
    setSearch("");
    setOverdueOnly(false);
  }

  // Nesting + the Browse/follow-up colour coding apply ONLY when a single meeting
  // is selected (the board then reads like that meeting). The default "All
  // meetings" view stays flat and keeps the neutral status-accent styling.
  const meetingSelected = meetingFilter !== "all";
  const tree = useMemo(() => {
    const ids = new Set(filtered.map((i) => i.id));
    const childrenOf: Record<string, BoardItem[]> = {};
    const top: BoardItem[] = [];
    for (const it of filtered) {
      if (meetingSelected && it.raisedFromRootId && ids.has(it.raisedFromRootId)) {
        (childrenOf[it.raisedFromRootId] ??= []).push(it);
      } else {
        top.push(it);
      }
    }
    return { top, childrenOf };
  }, [filtered, meetingSelected]);

  // Every row currently on screen (parents + their nested children), so "select
  // all" and bulk edits can never touch something you can't see.
  const visibleItems = useMemo(() => {
    const out: BoardItem[] = [];
    const walk = (list: BoardItem[]) => {
      for (const i of list) {
        out.push(i);
        walk(tree.childrenOf[i.id] ?? []);
      }
    };
    walk(tree.top);
    return out;
  }, [tree]);

  // Changing tab changes what's on screen — drop the selection so a bulk action
  // can't silently apply to rows you've navigated away from.
  useEffect(() => setSelected(new Set()), [activeTab]);

  const selectedItems = visibleItems.filter((i) => selected.has(i.id));
  const allVisibleSelected = visibleItems.length > 0 && selectedItems.length === visibleItems.length;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Apply one change to every selected row. Sequential on purpose: 40 parallel
  // writes would hammer the connection pool for no real gain.
  async function bulkEdit(
    field: "status" | "type" | "assignedTo" | "dueDate" | "area",
    value: string
  ) {
    const targets = selectedItems;
    if (targets.length === 0) return;
    const apply = (i: BoardItem): BoardItem => {
      if (field === "status") return { ...i, status: value };
      if (field === "type") return { ...i, type: value };
      if (field === "assignedTo") return { ...i, assignedTo: value || null };
      if (field === "area") return { ...i, area: value };
      return { ...i, dueDate: value || null };
    };
    const ids = new Set(targets.map((t) => t.id));
    setItems((prev) => prev.map((i) => (ids.has(i.id) ? apply(i) : i)));
    setBulkProgress({ done: 0, total: targets.length });
    let failed = 0;
    for (let n = 0; n < targets.length; n++) {
      const item = targets[n];
      const targetId = field === "status" ? item.latestEntryId : item.id;
      try {
        const res = await fetch(`/api/minutes/${targetId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: value })
        });
        if (!res.ok) failed += 1;
      } catch {
        failed += 1;
      }
      setBulkProgress({ done: n + 1, total: targets.length });
    }
    setBulkProgress(null);
    setSelected(new Set());
    if (failed > 0) alert(`${failed} of ${targets.length} item(s) could not be updated.`);
    router.refresh();
  }

  // One board row (editable). `isNested` hides the "↳ under …" caption since the
  // visual nesting already conveys it.
  function renderRow(it: BoardItem, isNested: boolean) {
    const overdue = isOverdue(it);
    const done = it.status === "Closed" || it.status === "Cancelled";
    return (
      <div
        className={`flex items-start gap-3 rounded-lg border border-l-4 p-3 ${
          meetingSelected
            ? it.rootMeetingId === meetingFilter
              ? // Raised in the selected meeting → new activity → blue.
                "border-blue-200 border-l-brand-blue bg-blue-50"
              : // Carried in from an earlier meeting → follow-up item → yellow.
                "border-amber-200 border-l-amber-500 bg-amber-50"
            : `border-slate-200 bg-white ${STATUS_ACCENT[it.status] ?? "border-l-slate-300"}`
        }`}
      >
        <input
          type="checkbox"
          checked={selected.has(it.id)}
          onChange={() => toggleSelect(it.id)}
          className="mt-1 h-4 w-4 shrink-0"
          title="Select for a bulk change"
          aria-label={`Select ${it.title}`}
        />
        {/* Status — editable inline */}
        <select
          value={it.status}
          onChange={(e) => editItem(it, "status", e.target.value)}
          title="Status"
          className={`mt-0.5 w-[104px] shrink-0 cursor-pointer rounded border border-transparent px-1.5 py-0.5 text-xs font-semibold ${
            STATUS_BADGE[it.status] ?? "bg-slate-100 text-slate-600"
          }`}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:flex-row md:items-start md:justify-between md:gap-4">
          <div className="min-w-0">
            <button
              onClick={() => setOpenItem(it)}
              title="View history"
              className={`text-left font-medium hover:underline ${
                done ? "text-slate-500" : "text-slate-800"
              }`}
            >
              {it.title || <span className="italic text-slate-400">Untitled</span>}
            </button>

            {it.description && (
              <p className="mt-0.5 line-clamp-2 text-sm font-normal text-slate-500">
                {it.description}
              </p>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500">
              <select
                value={it.type}
                onChange={(e) => editItem(it, "type", e.target.value)}
                title="Type"
                className={`cursor-pointer rounded border border-transparent px-1.5 py-0.5 font-semibold ${
                  TYPE_BADGE[it.type] ?? "bg-slate-100 text-slate-600"
                }`}
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {it.devopsItemId && (
                <span className="rounded bg-orange-50 px-1.5 py-0.5 text-orange-600">
                  #{it.devopsItemId}
                </span>
              )}
              {it.updateCount > 0 && (
                <button
                  onClick={() => setOpenItem(it)}
                  title="View history"
                  className="text-slate-400 hover:text-slate-600 hover:underline"
                >
                  {it.updateCount} update{it.updateCount > 1 ? "s" : ""}
                </button>
              )}
              {!isNested && it.raisedFromTitle && (
                <span className="text-slate-400" title="Raised under another item">
                  ↳ under “{it.raisedFromTitle}”
                </span>
              )}
              {/* When it was last discussed — and a nudge when it's gone quiet. */}
              {(() => {
                const d = daysSince(it.lastActivity);
                const stale = isOpen(it.status) && d >= STALE_DAYS;
                return (
                  <span
                    className={stale ? "font-medium text-amber-700" : "text-slate-500"}
                    title={`Last discussed in "${it.thread[0]?.meetingTitle ?? ""}"`}
                  >
                    🕒 {agoLabel(d)}
                    {stale ? " · stale" : ""}
                  </span>
                );
              })()}
              {it.tags.length > 0 && <TagBadges tags={it.tags} />}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-slate-500 md:justify-end">
            <select
              value={it.assignedTo ?? ""}
              onChange={(e) => editItem(it, "assignedTo", e.target.value)}
              title="Owner"
              className="cursor-pointer rounded border border-slate-300 px-1.5 py-0.5 text-slate-600"
            >
              <option value="">Unassigned</option>
              {it.assignedTo && !members.includes(it.assignedTo) && (
                <option value={it.assignedTo}>{it.assignedTo}</option>
              )}
              {members.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            {/* A due date only takes space once it exists (or you ask for it). */}
            {it.dueDate || dateOpen === it.id ? (
              <input
                type="date"
                autoFocus={dateOpen === it.id && !it.dueDate}
                value={toDateInput(it.dueDate)}
                onChange={(e) => {
                  editItem(it, "dueDate", e.target.value);
                  setDateOpen(null);
                }}
                onBlur={() => setDateOpen(null)}
                title="Due date"
                className={`cursor-pointer rounded px-1.5 py-0.5 ${
                  overdue ? "bg-red-50 font-medium text-red-600" : "bg-slate-100 text-slate-600"
                }`}
              />
            ) : (
              <button
                onClick={() => setDateOpen(it.id)}
                className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                title="Set a due date"
              >
                + due date
              </button>
            )}
            {/* Area is editable here — re-file an item without leaving the board. */}
            <select
              value={it.area}
              onChange={(e) => editItem(it, "area", e.target.value)}
              title="Tab — move this item to another area"
              className="max-w-[150px] cursor-pointer appearance-none truncate rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 hover:ring-1 hover:ring-slate-300"
            >
              {!areas.includes(it.area) && <option value={it.area}>{it.area}</option>}
              {areas.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    );
  }

  // An item plus its nested raised sub-items (recursive).
  function renderNode(it: BoardItem, depth: number) {
    const kids = tree.childrenOf[it.id] ?? [];
    return (
      <li key={it.id}>
        {renderRow(it, depth > 0)}
        {kids.length > 0 && (
          <ul className="mt-2 space-y-2 border-l-2 border-slate-200 pl-3 md:pl-4">
            {kids.map((k) => renderNode(k, depth + 1))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      {/* Header */}
      <header className="shrink-0 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <a href="/browse" className="text-lg font-bold hover:text-brand-blue sm:text-xl">
          Meeting Minutes
        </a>
        <span className="text-slate-300">/</span>
        <span className="truncate text-sm font-medium text-slate-600 sm:text-base">
          {project.name}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <a
            href={`/report/project/${project.id}`}
            className="rounded bg-gradient-to-r from-brand-blue to-brand-purple px-3 py-1.5 text-sm font-medium text-white"
            title="A printable status report for the whole project"
          >
            📄 Status Report
          </a>
          <a
            href="/auto"
            className="rounded bg-gradient-to-r from-brand-pink to-brand-purple px-3 py-1.5 text-sm font-medium text-white"
          >
            + New Meeting
          </a>
          <a
            href="/dashboard"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            ★ My Dashboard
          </a>
          <a
            href="/browse"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            ← Browse
          </a>
          <span className="hidden text-sm text-slate-500 sm:inline">{userName}</span>
          <form action="/auth/signout" method="post">
            <button className="rounded border border-slate-300 px-3 py-1.5 text-sm">Sign out</button>
          </form>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6">
          {/* How this project's minutes are written — shapes AI Recommendation. */}
          <div className="mb-4">
            <StyleProfilePanel projectId={project.id} />
          </div>

          {/* Title + summary */}
          <div className="mb-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-slate-800 sm:text-2xl">{project.name}</h1>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Board
              </span>
            </div>
            {/* The totals double as filters. */}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-600">
                {summary.total} items
              </span>
              <button
                onClick={() => {
                  setStatusFilter("open");
                  setOverdueOnly(false);
                }}
                className={`rounded-full bg-amber-50 px-3 py-1 font-medium text-amber-700 ${
                  statusFilter === "open" && !overdueOnly ? "ring-2 ring-amber-400" : "hover:brightness-95"
                }`}
              >
                {summary.open} open
              </button>
              {summary.overdue > 0 && (
                <button
                  onClick={() => {
                    setStatusFilter("open");
                    setOverdueOnly((v) => !v);
                  }}
                  className={`rounded-full bg-red-50 px-3 py-1 font-medium text-red-600 ${
                    overdueOnly ? "ring-2 ring-red-400" : "hover:brightness-95"
                  }`}
                >
                  {summary.overdue} overdue
                </button>
              )}
              <button
                onClick={() => {
                  setStatusFilter("closed");
                  setOverdueOnly(false);
                }}
                className={`rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-700 ${
                  statusFilter === "closed" ? "ring-2 ring-emerald-400" : "hover:brightness-95"
                }`}
              >
                {summary.done} closed
              </button>
              {summary.cancelled > 0 && (
                <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-400">
                  {summary.cancelled} cancelled
                </span>
              )}
            </div>
            {/* Why the board can't prioritise: the data isn't there yet. */}
            {(summary.noOwner > 0 || summary.noDue > 0) && (
              <p className="mt-1.5 text-xs text-slate-400">
                {summary.noOwner > 0 && <>{summary.noOwner} open item{summary.noOwner === 1 ? "" : "s"} have no owner</>}
                {summary.noOwner > 0 && summary.noDue > 0 && " · "}
                {summary.noDue > 0 && <>{summary.noDue} have no due date</>}
              </p>
            )}
          </div>

          {/* Filter bar */}
          <div className="mb-3 space-y-2 rounded-lg border border-slate-200 bg-white p-3">
            {/* Row 1: search (grows) + sort */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[180px] flex-1">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                  ⌕
                </span>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search items…"
                  className="w-full rounded-md border border-slate-300 py-1.5 pl-8 pr-8 text-sm"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-1 text-slate-400 hover:text-slate-600"
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                Sort
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as typeof sort)}
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-700"
                >
                  <option value="activity">Recent activity</option>
                  <option value="stale">Untouched longest</option>
                  <option value="due">Due date (soonest)</option>
                  <option value="title">Title A–Z</option>
                  <option value="status">Status (New → Closed)</option>
                </select>
              </label>
            </div>

            {/* Row 2: status + type + assignee + flags */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-sm">
                {(["open", "closed", "all"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={`px-3 py-1 capitalize ${
                      statusFilter === s
                        ? "bg-brand-blue text-white"
                        : "bg-white text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>

              <MultiSelectDropdown
                label="All types"
                options={TYPE_OPTIONS.map((t) => ({ value: t, label: t }))}
                selected={typeFilter}
                onChange={setTypeFilter}
              />

              <MultiSelectDropdown
                label="Anyone"
                options={[
                  { value: "__unassigned", label: "Unassigned" },
                  ...members.map((m) => ({ value: m, label: m }))
                ]}
                selected={assigneeFilter}
                onChange={setAssigneeFilter}
              />

              {meetings.length > 0 && (
                <select
                  value={meetingFilter}
                  onChange={(e) => setMeetingFilter(e.target.value)}
                  className="max-w-[240px] rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-700"
                  title="Filter by meeting"
                >
                  <option value="all">All meetings</option>
                  {meetings.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
              )}

              <span className="mx-0.5 hidden h-5 w-px bg-slate-200 sm:block" />

              {/* Flags */}
              <div className="flex flex-wrap items-center gap-1">
                {MINUTE_TAGS.map((tag) => {
                  const on = flagFilter.includes(tag);
                  return (
                    <button
                      key={tag}
                      onClick={() => toggleFlag(tag)}
                      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                        on
                          ? TAG_STYLES[tag]
                          : "border-slate-200 bg-white text-slate-400 hover:bg-slate-50"
                      }`}
                      title={`Filter by ${tag}`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>

              {activeFilterCount > 0 && (
                <button
                  onClick={clearFilters}
                  className="ml-auto rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                >
                  Clear filters ({activeFilterCount})
                </button>
              )}
            </div>
          </div>

          {/* Area tabs */}
          <div className="mb-4 flex flex-wrap gap-1.5">
            {["All", ...areas].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`rounded-full px-3 py-1 text-sm font-medium ${
                  activeTab === tab
                    ? "bg-slate-800 text-white"
                    : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                }`}
              >
                {tab}
                <span
                  className={`ml-1.5 text-xs ${
                    activeTab === tab ? "text-slate-300" : "text-slate-400"
                  }`}
                >
                  {areaCounts[tab] ?? 0}
                </span>
              </button>
            ))}
          </div>

          {/* Items */}
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center text-sm text-slate-400">
              No items match these filters.
            </div>
          ) : (
            <>
              <label className="mb-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelected(
                      allVisibleSelected ? new Set() : new Set(visibleItems.map((i) => i.id))
                    )
                  }
                  className="h-4 w-4"
                />
                Select all {visibleItems.length} shown
              </label>
              <ul className="space-y-2">
                {tree.top.map((it) => renderNode(it, 0))}
              </ul>
            </>
          )}
        </div>
      </main>

      {/* Bulk action bar — floats once rows are ticked. */}
      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-white shadow-xl">
          {bulkProgress ? (
            <span className="px-1">
              Updating {bulkProgress.done} of {bulkProgress.total}…
            </span>
          ) : (
            <>
              <span className="whitespace-nowrap font-medium">
                {selectedItems.length} selected
              </span>
              <span className="h-4 w-px bg-slate-600" />
              <select
                value=""
                onChange={(e) => e.target.value && bulkEdit("area", e.target.value)}
                className="cursor-pointer rounded bg-slate-700 px-2 py-1 text-sm text-white"
                title="Move the selected items to another tab"
              >
                <option value="">Move to tab…</option>
                {areas.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
              <select
                value=""
                onChange={(e) => e.target.value && bulkEdit("assignedTo", e.target.value === "__none" ? "" : e.target.value)}
                className="cursor-pointer rounded bg-slate-700 px-2 py-1 text-sm text-white"
                title="Assign the selected items"
              >
                <option value="">Assign…</option>
                <option value="__none">Unassigned</option>
                {members.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <select
                value=""
                onChange={(e) => e.target.value && bulkEdit("status", e.target.value)}
                className="cursor-pointer rounded bg-slate-700 px-2 py-1 text-sm text-white"
                title="Set status on the selected items"
              >
                <option value="">Status…</option>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-slate-300">
                Due
                <input
                  type="date"
                  onChange={(e) => e.target.value && bulkEdit("dueDate", e.target.value)}
                  className="cursor-pointer rounded bg-slate-700 px-2 py-1 text-sm text-white"
                  title="Set a due date on the selected items"
                />
              </label>
              <span className="h-4 w-px bg-slate-600" />
              <button
                onClick={() => setSelected(new Set())}
                className="rounded px-2 py-1 text-slate-300 hover:bg-slate-700 hover:text-white"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {/* Thread history popup */}
      {openItem && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
          onClick={() => setOpenItem(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {/* Read-only summary — edit these fields inline on the row. */}
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                      TYPE_BADGE[openItem.type] ?? "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {openItem.type}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                      STATUS_BADGE[openItem.status] ?? "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {openItem.status}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                    {openItem.area}
                  </span>
                </div>
                <h2 className="mt-2 text-base font-semibold text-slate-800">
                  {openItem.title || "Untitled"}
                </h2>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                  {openItem.assignedTo && <span>👤 {openItem.assignedTo}</span>}
                  {openItem.dueDate && <span>📅 due {fmtDate(openItem.dueDate)}</span>}
                  {openItem.devopsItemId && <span>DevOps #{openItem.devopsItemId}</span>}
                </div>
                {openItem.tags.length > 0 && (
                  <div className="mt-2">
                    <TagBadges tags={openItem.tags} />
                  </div>
                )}
              </div>
              <button
                onClick={() => setOpenItem(null)}
                className="shrink-0 rounded-full px-2 py-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              History ({openItem.thread.length})
            </div>
            <ol className="divide-y divide-slate-200">
              {openItem.thread.map((e) => (
                <li key={e.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-medium text-slate-600">{e.meetingTitle}</span>
                    <span>·</span>
                    <span>{fmtDate(e.date)}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-semibold ${
                        STATUS_BADGE[e.status] ?? "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {e.status}
                    </span>
                    {e.isRoot && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400">
                        raised
                      </span>
                    )}
                  </div>
                  {e.description && (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                      {e.description}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
