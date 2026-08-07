"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TagBadges } from "@/components/TagChips";
import { MINUTE_TAGS, TAG_STYLES } from "@/lib/tags";

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
  area: string;
  title: string;
  type: string; // label
  status: string; // current, label
  assignedTo: string | null;
  dueDate: string | null; // ISO
  tags: string[];
  devopsItemId: number | null;
  updateCount: number;
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
  Completed: "bg-emerald-100 text-emerald-700",
  Cancelled: "bg-slate-200 text-slate-500"
};

// A coloured left edge per status, for peripheral "where does this stand" scanning.
const STATUS_ACCENT: Record<string, string> = {
  New: "border-l-slate-300",
  Initiated: "border-l-indigo-400",
  "In Progress": "border-l-blue-500",
  Completed: "border-l-emerald-500",
  Cancelled: "border-l-slate-300"
};

// Lifecycle order, so "Sort by status" groups items in a sensible progression
// rather than alphabetically.
const STATUS_RANK: Record<string, number> = {
  New: 0,
  Initiated: 1,
  "In Progress": 2,
  Completed: 3,
  Cancelled: 4
};

const TYPE_OPTIONS = ["To-Do", "Devops", "Action", "Note"];
const STATUS_OPTIONS = ["New", "Initiated", "In Progress", "Completed", "Cancelled"];

function isOpen(status: string) {
  return status !== "Completed" && status !== "Cancelled";
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

function isOverdue(item: BoardItem) {
  if (!item.dueDate || !isOpen(item.status)) return false;
  const due = new Date(item.dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

export default function ProjectBoardClient({
  project,
  items,
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
  const [activeTab, setActiveTab] = useState<string>("All");
  const [statusFilter, setStatusFilter] = useState<"open" | "completed" | "all">("open");
  const [typeFilter, setTypeFilter] = useState<string>("All");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("All");
  const [meetingFilter, setMeetingFilter] = useState<string>("all");
  const [flagFilter, setFlagFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"activity" | "due" | "title" | "status">("activity");
  const [openItem, setOpenItem] = useState<BoardItem | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);
  const router = useRouter();

  // Edit an item straight from the board's detail panel. Status is point-in-time
  // (it's the latest entry's, which is what the board shows), so it saves to the
  // latest entry; type/owner/due are the item's identity and save to the root.
  async function editItem(
    item: BoardItem,
    field: "status" | "type" | "assignedTo" | "dueDate",
    value: string
  ) {
    const targetId = field === "status" ? item.latestEntryId : item.id;
    const patch: Record<string, string> = { [field]: value };
    // Optimistic: reflect it in the open panel right away.
    setOpenItem((prev) => {
      if (!prev || prev.id !== item.id) return prev;
      if (field === "status") return { ...prev, status: value };
      if (field === "type") return { ...prev, type: value };
      if (field === "assignedTo") return { ...prev, assignedTo: value || null };
      return { ...prev, dueDate: value || null };
    });
    setSavingField(field);
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
    } finally {
      setSavingField(null);
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
            : it.status === "Completed";
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
      if (statusFilter === "completed" && it.status !== "Completed") return false;
      if (typeFilter !== "All" && it.type !== typeFilter) return false;
      if (assigneeFilter !== "All") {
        if (assigneeFilter === "__unassigned") {
          if (it.assignedTo) return false;
        } else if (it.assignedTo !== assigneeFilter) return false;
      }
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
  }, [items, activeTab, statusFilter, typeFilter, assigneeFilter, meetingFilter, flagFilter, search, sort]);

  // Summary strip across the WHOLE project (independent of filters), so the boss
  // always sees the true totals.
  const summary = useMemo(() => {
    let open = 0,
      done = 0,
      cancelled = 0;
    for (const it of items) {
      if (it.status === "Completed") done += 1;
      else if (it.status === "Cancelled") cancelled += 1;
      else open += 1;
    }
    return { total: items.length, open, done, cancelled };
  }, [items]);

  const activeFilterCount =
    (statusFilter !== "open" ? 1 : 0) +
    (typeFilter !== "All" ? 1 : 0) +
    (assigneeFilter !== "All" ? 1 : 0) +
    (meetingFilter !== "all" ? 1 : 0) +
    flagFilter.length +
    (search.trim() ? 1 : 0);

  function clearFilters() {
    setStatusFilter("open");
    setTypeFilter("All");
    setAssigneeFilter("All");
    setMeetingFilter("all");
    setFlagFilter([]);
    setSearch("");
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
          {/* Title + summary */}
          <div className="mb-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-slate-800 sm:text-2xl">{project.name}</h1>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Board
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              <span className="font-semibold text-slate-700">{summary.total}</span> items ·{" "}
              <span className="font-semibold text-amber-600">{summary.open}</span> open ·{" "}
              <span className="font-semibold text-emerald-600">{summary.done}</span> done
              {summary.cancelled > 0 && (
                <>
                  {" "}
                  · <span className="font-semibold text-slate-400">{summary.cancelled}</span>{" "}
                  cancelled
                </>
              )}
            </p>
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
                  <option value="due">Due date (soonest)</option>
                  <option value="title">Title A–Z</option>
                  <option value="status">Status (New → Done)</option>
                </select>
              </label>
            </div>

            {/* Row 2: status + type + assignee + flags */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-sm">
                {(["open", "completed", "all"] as const).map((s) => (
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

              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-700"
              >
                <option value="All">All types</option>
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>

              <select
                value={assigneeFilter}
                onChange={(e) => setAssigneeFilter(e.target.value)}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-700"
              >
                <option value="All">Anyone</option>
                <option value="__unassigned">Unassigned</option>
                {members.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>

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
            <ul className="space-y-2">
              {filtered.map((it) => {
                const overdue = isOverdue(it);
                const done = it.status === "Completed" || it.status === "Cancelled";
                return (
                  <li key={it.id}>
                    <button
                      onClick={() => setOpenItem(it)}
                      className={`flex w-full items-start gap-3 rounded-lg border border-slate-200 border-l-4 bg-white p-3 text-left transition hover:bg-slate-50 hover:shadow-sm ${
                        STATUS_ACCENT[it.status] ?? "border-l-slate-300"
                      }`}
                    >
                      <span
                        className={`mt-0.5 inline-flex w-[92px] shrink-0 justify-center whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold ${
                          STATUS_BADGE[it.status] ?? "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {it.status}
                      </span>

                      <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:flex-row md:items-start md:justify-between md:gap-4">
                        {/* Left: title + type/updates/flags */}
                        <div className="min-w-0">
                          <div
                            className={`font-medium ${
                              done ? "text-slate-500" : "text-slate-800"
                            }`}
                          >
                            {it.title || <span className="italic text-slate-400">Untitled</span>}
                          </div>

                          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500">
                            <span
                              className={`rounded px-1.5 py-0.5 font-semibold ${
                                TYPE_BADGE[it.type] ?? "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {it.type}
                            </span>
                            {it.devopsItemId && (
                              <span className="rounded bg-orange-50 px-1.5 py-0.5 text-orange-600">
                                #{it.devopsItemId}
                              </span>
                            )}
                            {it.updateCount > 0 && (
                              <span className="text-slate-400">
                                {it.updateCount} update{it.updateCount > 1 ? "s" : ""}
                              </span>
                            )}
                            {it.raisedFromTitle && (
                              <span className="text-slate-400" title="Raised under another item">
                                ↳ under “{it.raisedFromTitle}”
                              </span>
                            )}
                            {it.tags.length > 0 && <TagBadges tags={it.tags} />}
                          </div>
                        </div>

                        {/* Right: owner · due · area — fills the row width on desktop,
                            stacks under the title on mobile */}
                        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 md:justify-end">
                          {it.assignedTo && <span className="whitespace-nowrap">👤 {it.assignedTo}</span>}
                          {it.dueDate && (
                            <span
                              className={`whitespace-nowrap ${
                                overdue ? "font-semibold text-red-600" : ""
                              }`}
                            >
                              📅 {fmtDate(it.dueDate)}
                              {overdue && " · overdue"}
                            </span>
                          )}
                          {activeTab === "All" && (
                            <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                              {it.area}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>

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
                <h2 className="text-base font-semibold text-slate-800">
                  {openItem.title || "Untitled"}
                </h2>
                {/* Edit the item's state right here — changes save on the spot. */}
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-500">Type</span>
                    <select
                      value={openItem.type}
                      onChange={(e) => editItem(openItem, "type", e.target.value)}
                      className="rounded border border-slate-300 px-2 py-1 text-slate-700"
                    >
                      {TYPE_OPTIONS.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-500">Status</span>
                    <select
                      value={openItem.status}
                      onChange={(e) => editItem(openItem, "status", e.target.value)}
                      className="rounded border border-slate-300 px-2 py-1 text-slate-700"
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-500">Owner</span>
                    <select
                      value={openItem.assignedTo ?? ""}
                      onChange={(e) => editItem(openItem, "assignedTo", e.target.value)}
                      className="rounded border border-slate-300 px-2 py-1 text-slate-700"
                    >
                      <option value="">— Unassigned —</option>
                      {openItem.assignedTo && !members.includes(openItem.assignedTo) && (
                        <option value={openItem.assignedTo}>{openItem.assignedTo}</option>
                      )}
                      {members.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-500">Due date</span>
                    <input
                      type="date"
                      value={toDateInput(openItem.dueDate)}
                      onChange={(e) => editItem(openItem, "dueDate", e.target.value)}
                      className="rounded border border-slate-300 px-2 py-1 text-slate-700"
                    />
                  </label>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                    {openItem.area}
                  </span>
                  {openItem.devopsItemId && <span>DevOps #{openItem.devopsItemId}</span>}
                  {savingField && <span className="text-slate-400">Saving…</span>}
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
