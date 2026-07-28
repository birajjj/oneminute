"use client";

import { useState, useMemo } from "react";

export interface ShellMeeting {
  id: string;
  title: string;
  date: string;
  projectId: string;
  projectName: string;
}

export interface ShellProject {
  id: string;
  name: string;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" }) +
    ", " +
    d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })
  );
}

/**
 * Shared header + "Recent Meetings" sidebar chrome.
 * Sidebar meetings link to /browse. Used by pages that aren't the browse
 * master-detail itself (e.g. /auto).
 */
export default function AppShell({
  meetings,
  projects,
  userName,
  children
}: {
  meetings: ShellMeeting[];
  projects: ShellProject[];
  userName: string;
  children: React.ReactNode;
}) {
  const [projectFilter, setProjectFilter] = useState("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let list = meetings;
    if (projectFilter !== "all") list = list.filter((m) => m.projectId === projectFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (m) => m.title.toLowerCase().includes(q) || m.projectName.toLowerCase().includes(q)
      );
    }
    return list;
  }, [meetings, projectFilter, search]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <h1 className="text-xl font-bold">Meeting Minutes</h1>
        <div className="flex items-center gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes…"
            className="w-64 rounded-full border border-slate-300 px-4 py-1.5 text-sm"
          />
          <a
            href="/browse"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium"
          >
            Browse
          </a>
          <span className="text-sm text-slate-500">{userName}</span>
          <form action="/auth/signout" method="post">
            <button className="rounded border border-slate-300 px-3 py-1.5 text-sm">Sign out</button>
          </form>
        </div>
      </header>

      <div className="flex">
        <aside className="w-72 shrink-0 border-r border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-lg font-bold">Recent Meetings</h2>

          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="mb-4 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <div className="space-y-2">
            {filtered.length === 0 && <p className="text-sm text-slate-400">No meetings.</p>}
            {filtered.map((m) => (
              <a
                key={m.id}
                href="/browse"
                className="block rounded-lg border border-slate-200 bg-slate-50 p-3 hover:bg-slate-100"
              >
                <div className="font-semibold text-brand-blue">{m.title}</div>
                <div className="text-xs text-slate-500">{fmtDate(m.date)}</div>
                <div className="text-xs text-slate-500">{m.projectName}</div>
              </a>
            ))}
          </div>
        </aside>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
