"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TagBadges } from "@/components/TagChips";

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
  lastActivity: string; // ISO
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
  const [showDone, setShowDone] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
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

  const visible = useMemo(
    () => mine.filter((it) => projectFilter.length === 0 || projectFilter.includes(it.projectId)),
    [mine, projectFilter]
  );

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
  const grouped = useMemo(() => {
    const g: Record<Bucket, DashItem[]> = { overdue: [], week: [], later: [] };
    for (const it of open) g[bucketOf(it)].push(it);
    const byDue = (a: DashItem, b: DashItem) => {
      const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      if (ad !== bd) return ad - bd;
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
    };
    (Object.keys(g) as Bucket[]).forEach((k) => g[k].sort(byDue));
    return g;
  }, [open]);

  function toggleProject(id: string) {
    setProjectFilter((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  function card(it: DashItem) {
    const itemOpen = isOpen(it.status);
    const overdue = isOverdue(it.dueDate, itemOpen);
    return (
      <li key={it.id} className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className={`font-medium ${itemOpen ? "text-slate-800" : "text-slate-500"}`}>
              {it.title || <span className="italic text-slate-400">Untitled</span>}
            </div>
            {it.description && (
              <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{it.description}</p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
              {/* Type — editable */}
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
              {/* Status — editable (replaces the old complete checkbox) */}
              <select
                value={it.status}
                onChange={(e) => editItem(it, "status", e.target.value)}
                title="Status"
                className={`cursor-pointer rounded border border-transparent px-1.5 py-0.5 font-semibold ${
                  STATUS_BADGE[it.status] ?? "bg-slate-100 text-slate-600"
                }`}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              {/* Due date — editable */}
              <span className="inline-flex items-center gap-1 text-slate-400">
                Due
                <input
                  type="date"
                  value={toDateInput(it.dueDate)}
                  onChange={(e) => editItem(it, "dueDate", e.target.value)}
                  title="Due date"
                  className={`cursor-pointer rounded border px-1.5 py-0.5 ${
                    overdue
                      ? "border-red-300 bg-red-50 text-red-600"
                      : "border-slate-300 text-slate-600"
                  }`}
                />
              </span>
              {overdue && <span className="font-medium text-red-600">overdue</span>}
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
      </li>
    );
  }

  function section(bucket: Bucket) {
    const list = grouped[bucket];
    if (list.length === 0) return null;
    const meta = BUCKET_META[bucket];
    return (
      <section className="mb-6">
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className={`text-sm font-semibold uppercase tracking-wide ${meta.accent}`}>
            {meta.title}
          </h2>
          <span className="text-xs text-slate-400">
            {list.length} · {meta.hint}
          </span>
        </div>
        <ul className="space-y-2">{list.map(card)}</ul>
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
                <div className="mt-3 flex flex-wrap gap-2 text-sm">
                  <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
                    {counts.open} open
                  </span>
                  {counts.overdue > 0 && (
                    <span className="rounded-full bg-red-50 px-3 py-1 font-medium text-red-600">
                      {counts.overdue} overdue
                    </span>
                  )}
                  {counts.week > 0 && (
                    <span className="rounded-full bg-amber-50 px-3 py-1 font-medium text-amber-700">
                      {counts.week} due this week
                    </span>
                  )}
                  <span className="rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-700">
                    {counts.done} completed
                  </span>
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
              ) : (
                <>
                  {open.length === 0 && (
                    <div className="mb-6 rounded-lg border border-dashed border-emerald-300 bg-emerald-50/50 py-10 text-center text-sm text-emerald-700">
                      🎉 All caught up — no open items.
                    </div>
                  )}
                  {section("overdue")}
                  {section("week")}
                  {section("later")}

                  {/* Completed — behind a toggle so it doesn't crowd the view. */}
                  {done.length > 0 && (
                    <section className="mt-2">
                      <button
                        onClick={() => setShowDone((s) => !s)}
                        className="mb-2 flex items-center gap-1 text-sm font-semibold uppercase tracking-wide text-emerald-700"
                      >
                        <span className="text-xs">{showDone ? "▾" : "▸"}</span>
                        Completed ({done.length})
                      </button>
                      {showDone && (
                        <ul className="space-y-2">
                          {done
                            .slice()
                            .sort(
                              (a, b) =>
                                new Date(b.lastActivity).getTime() -
                                new Date(a.lastActivity).getTime()
                            )
                            .map(card)}
                        </ul>
                      )}
                    </section>
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
