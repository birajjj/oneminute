"use client";

import { useMemo, useState } from "react";
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

const TYPE_OPTIONS = ["To-Do", "Devops", "Action", "Note"];

function isOpen(status: string) {
  return status !== "Completed" && status !== "Cancelled";
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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
  members,
  userName
}: {
  project: { id: string; name: string };
  items: BoardItem[];
  areas: string[];
  members: string[];
  userName: string;
}) {
  const [activeTab, setActiveTab] = useState<string>("All");
  const [statusFilter, setStatusFilter] = useState<"open" | "completed" | "all">("open");
  const [typeFilter, setTypeFilter] = useState<string>("All");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("All");
  const [flagFilter, setFlagFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"activity" | "due" | "title" | "status">("activity");
  const [openItem, setOpenItem] = useState<BoardItem | null>(null);

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
      if (flagFilter.length && !flagFilter.every((f) => it.tags.includes(f))) return false;
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
        case "status":
          return a.status.localeCompare(b.status);
        case "activity":
        default:
          return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      }
    });
    return list;
  }, [items, activeTab, statusFilter, typeFilter, assigneeFilter, flagFilter, search, sort]);

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
    flagFilter.length +
    (search.trim() ? 1 : 0);

  function clearFilters() {
    setStatusFilter("open");
    setTypeFilter("All");
    setAssigneeFilter("All");
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
        <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
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
                  <option value="due">Due date</option>
                  <option value="title">Title A–Z</option>
                  <option value="status">Status</option>
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

                      <div className="min-w-0 flex-1">
                        <div
                          className={`font-medium ${
                            done ? "text-slate-400 line-through" : "text-slate-800"
                          }`}
                        >
                          {it.title || <span className="italic text-slate-400">Untitled</span>}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                          <span
                            className={`rounded px-1.5 py-0.5 font-semibold ${
                              TYPE_BADGE[it.type] ?? "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {it.type}
                          </span>
                          {it.assignedTo && <span>👤 {it.assignedTo}</span>}
                          {it.dueDate && (
                            <span className={overdue ? "font-semibold text-red-600" : ""}>
                              📅 {fmtDate(it.dueDate)}
                              {overdue && " · overdue"}
                            </span>
                          )}
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
                        </div>

                        {it.tags.length > 0 && (
                          <div className="mt-1.5">
                            <TagBadges tags={it.tags} />
                          </div>
                        )}
                      </div>

                      {activeTab === "All" && (
                        <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                          {it.area}
                        </span>
                      )}
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
            <ol className="space-y-3 border-l-2 border-slate-100 pl-4">
              {openItem.thread.map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-slate-300" />
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
