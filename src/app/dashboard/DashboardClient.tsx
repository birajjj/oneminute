"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TagBadges } from "@/components/TagChips";
import { MINUTE_TAGS, TAG_STYLES } from "@/lib/tags";

export interface RosterMember {
  id: string;
  displayName: string;
}

export interface DashItem {
  id: string;
  assigneeId: string; // the roster person this item belongs to
  latestEntryId: string; // status edits target this (the item's current state)
  title: string;
  description: string | null;
  type: string; // label
  status: string; // current, label
  area: string;
  dueDate: string | null; // ISO
  projectId: string;
  projectName: string;
  devopsItemId: number | null;
  tags: string[];
  lastActivity: string; // ISO — meeting date of the item's newest entry
  lastMeetingTitle: string; // where it was last discussed
  raisedFromRootId: string | null;
  raisedFromTitle: string | null;
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

const TYPE_OPTIONS = ["Note", "To-Do", "Action", "Devops"];
const STATUS_OPTIONS = ["New", "Initiated", "In Progress", "Resolved", "Closed", "Cancelled"];

function isOpen(status: string) {
  return status !== "Closed" && status !== "Cancelled";
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ISO (or "YYYY-MM-DD") -> the value an <input type="date"> expects. Due dates
// are stored at UTC midnight, so the first 10 chars are the intended day.
function toDateInput(value: string | null) {
  return value ? value.slice(0, 10) : "";
}

function isOverdue(iso: string | null, open: boolean) {
  if (!iso || !open) return false;
  return new Date(iso) < startOfToday();
}

// How long an item has sat untouched — the question a personal dashboard is
// uniquely able to answer ("what have I not looked at in three weeks?").
const STALE_DAYS = 14;
function daysSince(iso: string) {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return Math.round((startOfToday().getTime() - d.getTime()) / 86_400_000);
}
function agoLabel(days: number) {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

// Which bucket an item falls into (open items only; done handled separately).
type Bucket = "overdue" | "week" | "later";
function bucketOf(item: DashItem): Bucket {
  if (!item.dueDate) return "later";
  const due = new Date(item.dueDate);
  const today = startOfToday();
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return "overdue";
  if (days <= 7) return "week";
  return "later";
}

const BUCKET_META: Record<Bucket, { title: string; accent: string; hint: string }> = {
  overdue: { title: "Overdue", accent: "text-red-600", hint: "Past their due date" },
  week: { title: "Due this week", accent: "text-amber-600", hint: "Due within 7 days" },
  later: { title: "Open", accent: "text-slate-700", hint: "No date, or later" }
};

export default function DashboardClient({
  items: initialItems,
  members,
  defaultAssigneeId,
  userId,
  userName
}: {
  items: DashItem[];
  members: RosterMember[];
  defaultAssigneeId: string | null;
  userId: string;
  userName: string;
}) {
  const router = useRouter();
  const [items, setItems] = useState<DashItem[]>(initialItems);
  // Re-sync when the server sends fresh data (after a router.refresh()).
  useEffect(() => setItems(initialItems), [initialItems]);

  // Which roster person's tasks we're showing. Defaults to the server's best
  // guess for "me"; the choice is remembered per login in this browser.
  const storageKey = `dash.me:${userId}`;
  const [selectedId, setSelectedId] = useState<string | null>(defaultAssigneeId);
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
    if (saved && members.some((m) => m.id === saved)) setSelectedId(saved);
  }, [storageKey, members]);
  function chooseMe(id: string) {
    setSelectedId(id);
    try {
      window.localStorage.setItem(storageKey, id);
    } catch {
      /* ignore */
    }
  }

  const [projectFilter, setProjectFilter] = useState<string[]>([]); // ids; empty = all
  const [typeFilter, setTypeFilter] = useState<string[]>([]); // labels; empty = all
  const [flagFilter, setFlagFilter] = useState<string[]>([]); // tags; empty = all
  const [search, setSearch] = useState("");
  // Which slice the summary chips are showing. "open" = the usual triage view.
  const [view, setView] = useState<"open" | "overdue" | "week" | "closed">("open");
  const [groupBy, setGroupBy] = useState<"urgency" | "project">("urgency");
  const [sort, setSort] = useState<"due" | "recent" | "stale" | "title">("due");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [savingId, setSavingId] = useState<string | null>(null);
  // Items whose due-date picker is open (an undated item shows "+ due date").
  const [dateOpen, setDateOpen] = useState<string | null>(null);
  // A different person's projects → reset the project chips.
  useEffect(() => setProjectFilter([]), [selectedId]);

  const selectedName = members.find((m) => m.id === selectedId)?.displayName ?? userName;
  const firstName = selectedName.split(" ")[0] || selectedName;

  // Just this person's items.
  const mine = useMemo(
    () => items.filter((it) => it.assigneeId === selectedId),
    [items, selectedId]
  );

  const projects = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of mine) map.set(it.projectId, it.projectName);
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [mine]);

  // Edit a field on a card. Status is point-in-time (the item's current state) →
  // saves to the latest entry; type and due date are the item's identity → the
  // root. Optimistic, then re-sync from the server.
  async function editItem(item: DashItem, field: "status" | "type" | "dueDate", value: string) {
    const targetId = field === "status" ? item.latestEntryId : item.id;
    setItems((prev) =>
      prev.map((i) => {
        if (i.id !== item.id) return i;
        if (field === "status") return { ...i, status: value };
        if (field === "type") return { ...i, type: value };
        return { ...i, dueDate: value || null };
      })
    );
    setSavingId(item.id);
    try {
      const res = await fetch(`/api/minutes/${targetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value })
      });
      if (!res.ok) throw new Error("Save failed");
      router.refresh();
    } catch {
      router.refresh(); // fall back to server truth
    } finally {
      setSavingId(null);
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mine.filter((it) => {
      if (projectFilter.length && !projectFilter.includes(it.projectId)) return false;
      if (typeFilter.length && !typeFilter.includes(it.type)) return false;
      // OR across flags — an item shows if it carries ANY selected flag.
      if (flagFilter.length && !it.tags.some((t) => flagFilter.includes(t))) return false;
      if (q) {
        const hay = `${it.title} ${it.description ?? ""} ${it.projectName} ${it.area}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [mine, projectFilter, typeFilter, flagFilter, search]);

  const open = visible.filter((it) => isOpen(it.status));
  const done = visible.filter((it) => it.status === "Closed");

  const counts = useMemo(() => {
    let overdue = 0;
    let week = 0;
    for (const it of open) {
      const b = bucketOf(it);
      if (b === "overdue") overdue += 1;
      else if (b === "week") week += 1;
    }
    return { open: open.length, overdue, week, done: done.length };
  }, [open, done]);

  // Group open items into buckets, each sorted by due date (soonest first),
  // undated last.
  // Open items, grouped the way the user asked and sorted within each group.
  const groups = useMemo(() => {
    const cmp = (a: DashItem, b: DashItem) => {
      switch (sort) {
        case "recent":
          return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
        case "stale": // longest untouched first
          return new Date(a.lastActivity).getTime() - new Date(b.lastActivity).getTime();
        case "title":
          return a.title.localeCompare(b.title);
        case "due":
        default: {
          const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
          const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
          if (ad !== bd) return ad - bd;
          return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
        }
      }
    };

    // The chips narrow which open items are in play.
    let list = open;
    if (view === "overdue") list = list.filter((it) => bucketOf(it) === "overdue");
    else if (view === "week") list = list.filter((it) => bucketOf(it) === "week");
    const sorted = [...list].sort(cmp);

    if (groupBy === "project") {
      const byProject: Record<string, DashItem[]> = {};
      for (const it of sorted) (byProject[it.projectName] ??= []).push(it);
      return Object.keys(byProject)
        .sort()
        .map((name) => ({
          key: name,
          title: name,
          hint: "",
          accent: "text-slate-700",
          items: byProject[name]
        }));
    }

    const g: Record<Bucket, DashItem[]> = { overdue: [], week: [], later: [] };
    for (const it of sorted) g[bucketOf(it)].push(it);
    return (["overdue", "week", "later"] as Bucket[])
      .filter((k) => g[k].length > 0)
      .map((k) => ({
        key: k,
        title: BUCKET_META[k].title,
        hint: BUCKET_META[k].hint,
        accent: BUCKET_META[k].accent,
        items: g[k]
      }));
  }, [open, view, groupBy, sort]);

  function toggleType(t: string) {
    setTypeFilter((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }
  function toggleFlag(t: string) {
    setFlagFilter((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }
  function toggleProject(id: string) {
    setProjectFilter((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  function card(it: DashItem) {
    const itemOpen = isOpen(it.status);
    const overdue = isOverdue(it.dueDate, itemOpen);
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className={`font-medium ${itemOpen ? "text-slate-800" : "text-slate-500"}`}>
              {it.title || <span className="italic text-slate-400">Untitled</span>}
            </div>
            {it.description && (
              <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{it.description}</p>
            )}
            {/* Controls read as pills — the native dropdown chrome is hidden so
                the list scans like a task list, not a data-entry form. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
              <select
                value={it.type}
                onChange={(e) => editItem(it, "type", e.target.value)}
                title="Type — click to change"
                className={`cursor-pointer appearance-none rounded px-1.5 py-0.5 font-semibold hover:ring-1 hover:ring-slate-300 ${
                  TYPE_BADGE[it.type] ?? "bg-slate-100 text-slate-600"
                }`}
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <select
                value={it.status}
                onChange={(e) => editItem(it, "status", e.target.value)}
                title="Status — click to change"
                className={`cursor-pointer appearance-none rounded px-1.5 py-0.5 font-semibold hover:ring-1 hover:ring-slate-300 ${
                  STATUS_BADGE[it.status] ?? "bg-slate-100 text-slate-600"
                }`}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
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
                    overdue
                      ? "bg-red-50 font-medium text-red-600"
                      : "bg-slate-100 text-slate-600"
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
              {overdue && <span className="font-medium text-red-600">overdue</span>}
              {/* How long since anyone touched this — surfaces forgotten work. */}
              {(() => {
                const d = daysSince(it.lastActivity);
                const stale = itemOpen && d >= STALE_DAYS;
                return (
                  <span
                    className={stale ? "font-medium text-amber-700" : "text-slate-500"}
                    title={`Last discussed in "${it.lastMeetingTitle}"`}
                  >
                    🕒 {agoLabel(d)}
                    {stale ? " · stale" : ""}
                  </span>
                );
              })()}
              {savingId === it.id && <span className="text-slate-400">saving…</span>}
              {it.devopsItemId && (
                <span className="rounded bg-orange-50 px-1.5 py-0.5 text-orange-600">
                  #{it.devopsItemId}
                </span>
              )}
              {it.tags.length > 0 && <TagBadges tags={it.tags} />}
            </div>
          </div>
          <a
            href={`/project/${it.projectId}`}
            className="shrink-0 whitespace-nowrap rounded bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-200"
            title={`Open ${it.projectName} board`}
          >
            {it.projectName}
            <span className="ml-1 text-slate-400">· {it.area}</span>
          </a>
        </div>
      </div>
    );
  }

  // One group (an urgency bucket or a project) — collapsible, with a count.
  function groupSection(g: {
    key: string;
    title: string;
    hint: string;
    accent: string;
    items: DashItem[];
  }) {
    const isCollapsed = collapsed.has(g.key);
    return (
      <section key={g.key} className="mb-6">
        <button
          onClick={() =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(g.key)) next.delete(g.key);
              else next.add(g.key);
              return next;
            })
          }
          className="mb-2 flex items-baseline gap-2 text-left"
        >
          <span className="text-xs text-slate-400">{isCollapsed ? "▸" : "▾"}</span>
          <h2 className={`text-sm font-semibold uppercase tracking-wide ${g.accent}`}>
            {g.title}
          </h2>
          <span className="text-xs text-slate-400">
            {g.items.length}
            {g.hint ? ` · ${g.hint}` : ""}
          </span>
        </button>
        {!isCollapsed && (
          <ul className="space-y-2">
            {g.items.map((it) => (
              <li key={it.id}>{card(it)}</li>
            ))}
          </ul>
        )}
      </section>
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
        <span className="text-sm font-medium text-slate-600 sm:text-base">My Dashboard</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <a
            href="/auto"
            className="rounded bg-gradient-to-r from-brand-pink to-brand-purple px-3 py-1.5 text-sm font-medium text-white"
          >
            + New Meeting
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
          {members.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center text-sm text-slate-400">
              No team members on the roster yet — add people so work can be assigned.
            </div>
          ) : (
            <>
              {/* Greeting + whose-tasks picker */}
              <div className="mb-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h1 className="text-xl font-bold text-slate-800 sm:text-2xl">
                    Hi {firstName} 👋
                  </h1>
                  <label className="flex items-center gap-1.5 text-xs text-slate-500">
                    Showing tasks for
                    <select
                      value={selectedId ?? ""}
                      onChange={(e) => chooseMe(e.target.value)}
                      className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-700"
                    >
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  Everything assigned to {selectedName}, across every project.
                </p>
                {/* Summary chips double as filters — click one to see just that
                    slice, click it again to go back to the full open list. */}
                <div className="mt-3 flex flex-wrap gap-2 text-sm">
                  {(
                    [
                      { key: "open", n: counts.open, label: "open", cls: "bg-slate-100 text-slate-700", ring: "ring-slate-400" },
                      { key: "overdue", n: counts.overdue, label: "overdue", cls: "bg-red-50 text-red-600", ring: "ring-red-400" },
                      { key: "week", n: counts.week, label: "due this week", cls: "bg-amber-50 text-amber-700", ring: "ring-amber-400" },
                      { key: "closed", n: counts.done, label: "closed", cls: "bg-emerald-50 text-emerald-700", ring: "ring-emerald-400" }
                    ] as const
                  ).map((c) =>
                    c.n === 0 && c.key !== "open" ? null : (
                      <button
                        key={c.key}
                        onClick={() => setView((v) => (v === c.key ? "open" : c.key))}
                        className={`rounded-full px-3 py-1 font-medium ${c.cls} ${
                          view === c.key ? `ring-2 ${c.ring}` : "hover:brightness-95"
                        }`}
                      >
                        {c.n} {c.label}
                      </button>
                    )
                  )}
                </div>
                {/* Without dates the urgency grouping can't help — say so once. */}
                {open.length > 0 && open.every((it) => !it.dueDate) && (
                  <p className="mt-2 text-xs text-slate-400">
                    None of these have a due date — add one to plan your week.
                  </p>
                )}
              </div>

              {/* Filters — search, type, flags. (Owner is the picker above;
                  open-vs-completed is the split below.) */}
              <div className="mb-4 space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                    ⌕
                  </span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search my items…"
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
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-0.5 text-xs text-slate-400">Type:</span>
                  {TYPE_OPTIONS.map((t) => {
                    const on = typeFilter.includes(t);
                    return (
                      <button
                        key={t}
                        onClick={() => toggleType(t)}
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                          on
                            ? "border-brand-blue bg-blue-50 text-brand-blue"
                            : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        {t}
                      </button>
                    );
                  })}
                  <span className="mx-1 hidden h-4 w-px bg-slate-200 sm:block" />
                  <span className="mr-0.5 text-xs text-slate-400">Flags:</span>
                  {MINUTE_TAGS.map((tag) => {
                    const on = flagFilter.includes(tag);
                    return (
                      <button
                        key={tag}
                        onClick={() => toggleFlag(tag)}
                        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                          on ? TAG_STYLES[tag] : "border-slate-200 bg-white text-slate-400 hover:bg-slate-50"
                        }`}
                        title={`Filter by ${tag}`}
                      >
                        {tag}
                      </button>
                    );
                  })}
                  {(typeFilter.length > 0 || flagFilter.length > 0 || search.trim()) && (
                    <button
                      onClick={() => {
                        setTypeFilter([]);
                        setFlagFilter([]);
                        setSearch("");
                      }}
                      className="ml-auto rounded px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
                {/* How the open list is organised. */}
                <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-2 text-xs text-slate-500">
                  <label className="flex items-center gap-1.5">
                    Group by
                    <select
                      value={groupBy}
                      onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
                      className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-700"
                    >
                      <option value="urgency">Urgency</option>
                      <option value="project">Project</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5">
                    Sort
                    <select
                      value={sort}
                      onChange={(e) => setSort(e.target.value as typeof sort)}
                      className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-700"
                    >
                      <option value="due">Due date (soonest)</option>
                      <option value="recent">Recently discussed</option>
                      <option value="stale">Untouched longest</option>
                      <option value="title">Title A–Z</option>
                    </select>
                  </label>
                </div>
              </div>

              {/* Project filter (only if this person has items in >1 project) */}
              {projects.length > 1 && (
                <div className="mb-5 flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs text-slate-400">Projects:</span>
                  {projects.map((p) => {
                    const on = projectFilter.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => toggleProject(p.id)}
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                          on
                            ? "border-brand-blue bg-blue-50 text-brand-blue"
                            : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                        }`}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                  {projectFilter.length > 0 && (
                    <button
                      onClick={() => setProjectFilter([])}
                      className="ml-1 rounded px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}

              {mine.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center text-sm text-slate-400">
                  Nothing is assigned to {selectedName} yet. Set them as the owner on a
                  minute (from a meeting or a project board) and it&apos;ll show up here.
                </div>
              ) : visible.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center text-sm text-slate-400">
                  No items match these filters.
                </div>
              ) : (
                <>
                  {view === "closed" ? (
                    <section>
                      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-emerald-700">
                        Closed
                        <span className="ml-2 text-xs font-normal text-slate-400">
                          {done.length} · most recent first
                        </span>
                      </h2>
                      <ul className="space-y-2">
                        {done
                          .slice()
                          .sort(
                            (a, b) =>
                              new Date(b.lastActivity).getTime() -
                              new Date(a.lastActivity).getTime()
                          )
                          .map((it) => (
                            <li key={it.id}>{card(it)}</li>
                          ))}
                      </ul>
                    </section>
                  ) : (
                    <>
                      {open.length === 0 && (
                        <div className="mb-6 rounded-lg border border-dashed border-emerald-300 bg-emerald-50/50 py-10 text-center text-sm text-emerald-700">
                          🎉 All caught up — no open items.
                        </div>
                      )}
                      {groups.map(groupSection)}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
