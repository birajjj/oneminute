"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TagBadges } from "@/components/TagChips";

export interface DashItem {
  id: string;
  latestEntryId: string; // status edits target this (the item's current state)
  title: string;
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
  Completed: "bg-emerald-100 text-emerald-700",
  Cancelled: "bg-slate-200 text-slate-500"
};

function isOpen(status: string) {
  return status !== "Completed" && status !== "Cancelled";
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

// How a due date reads relative to today, for the little coloured pill.
function dueMeta(iso: string | null, open: boolean) {
  if (!iso) return null;
  const due = new Date(iso);
  const today = startOfToday();
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (open && days < 0)
    return { text: `Overdue · ${fmtDate(iso)}`, cls: "bg-red-50 text-red-600" };
  if (open && days === 0) return { text: "Due today", cls: "bg-amber-50 text-amber-700" };
  if (open && days <= 7)
    return { text: `Due ${fmtDate(iso)}`, cls: "bg-amber-50 text-amber-700" };
  return { text: `Due ${fmtDate(iso)}`, cls: "bg-slate-100 text-slate-500" };
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
  userName
}: {
  items: DashItem[];
  userName: string;
}) {
  const router = useRouter();
  const [items, setItems] = useState<DashItem[]>(initialItems);
  // Re-sync when the server sends fresh data (after a router.refresh()).
  useEffect(() => setItems(initialItems), [initialItems]);

  const [projectFilter, setProjectFilter] = useState<string[]>([]); // ids; empty = all
  const [showDone, setShowDone] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const projects = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of initialItems) map.set(it.projectId, it.projectName);
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [initialItems]);

  async function setDone(item: DashItem, done: boolean) {
    // Optimistic — flip it locally, then persist to the item's current entry.
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, status: done ? "Completed" : "New" } : i))
    );
    setSavingId(item.id);
    try {
      const res = await fetch(`/api/minutes/${item.latestEntryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: done ? "Completed" : "New" })
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
    return items.filter(
      (it) => projectFilter.length === 0 || projectFilter.includes(it.projectId)
    );
  }, [items, projectFilter]);

  const open = visible.filter((it) => isOpen(it.status));
  const done = visible.filter((it) => it.status === "Completed");

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
    const open = isOpen(it.status);
    const dm = dueMeta(it.dueDate, open);
    return (
      <li
        key={it.id}
        className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3"
      >
        <input
          type="checkbox"
          checked={it.status === "Completed"}
          disabled={savingId === it.id}
          onChange={(e) => setDone(it, e.target.checked)}
          className="mt-1 h-4 w-4 shrink-0"
          title={it.status === "Completed" ? "Reopen" : "Mark complete"}
        />
        <div className="min-w-0 flex-1">
          <div className={`font-medium ${open ? "text-slate-800" : "text-slate-500"}`}>
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
            <span
              className={`rounded px-1.5 py-0.5 font-semibold ${
                STATUS_BADGE[it.status] ?? "bg-slate-100 text-slate-600"
              }`}
            >
              {it.status}
            </span>
            {dm && <span className={`rounded px-1.5 py-0.5 font-medium ${dm.cls}`}>{dm.text}</span>}
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
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
          {/* Greeting + summary */}
          <div className="mb-5">
            <h1 className="text-xl font-bold text-slate-800 sm:text-2xl">
              Hi {userName.split(" ")[0]} 👋
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Everything assigned to you, across every project.
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

          {/* Project filter (only if the user has items in more than one project) */}
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

          {items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center text-sm text-slate-400">
              Nothing is assigned to you yet. Items become yours when you&apos;re set as
              the owner on a minute.
            </div>
          ) : (
            <>
              {open.length === 0 && (
                <div className="mb-6 rounded-lg border border-dashed border-emerald-300 bg-emerald-50/50 py-10 text-center text-sm text-emerald-700">
                  🎉 You&apos;re all caught up — no open items.
                </div>
              )}
              {section("overdue")}
              {section("week")}
              {section("later")}

              {/* Completed — tucked behind a toggle so it doesn't crowd the view. */}
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
        </div>
      </main>
    </div>
  );
}
