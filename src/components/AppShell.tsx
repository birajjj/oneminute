"use client";

import { useEffect, useState, useMemo } from "react";
import ProjectFilterDropdown from "@/components/ProjectFilterDropdown";

const DESKTOP_SIDEBAR_COLLAPSED_KEY = "oneminute:desktop-sidebar-collapsed";

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);

  useEffect(() => {
    setDesktopSidebarCollapsed(
      window.localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSED_KEY) === "true"
    );
  }, []);

  function toggleDesktopSidebar() {
    setDesktopSidebarCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(DESKTOP_SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }

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
    <div className="flex h-screen flex-col bg-slate-50">
      <header className="shrink-0 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <button
          onClick={() => setSidebarOpen(true)}
          className="rounded p-1.5 text-slate-600 hover:bg-slate-100 md:hidden"
          aria-label="Open meetings menu"
        >
          ☰
        </button>
        <button
          onClick={toggleDesktopSidebar}
          className="hidden rounded p-1.5 text-slate-600 hover:bg-slate-100 md:inline-block"
          aria-label={desktopSidebarCollapsed ? "Show recent meetings" : "Hide recent meetings"}
          title={desktopSidebarCollapsed ? "Show recent meetings" : "Hide recent meetings"}
        >
          <span className="block h-0.5 w-4 bg-current" />
          <span className="mt-1 block h-0.5 w-4 bg-current" />
          <span className="mt-1 block h-0.5 w-4 bg-current" />
        </button>
        <h1 className="text-lg font-bold sm:text-xl">Meeting Minutes</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes…"
            className="w-36 rounded-full border border-slate-300 px-4 py-1.5 text-sm sm:w-64"
          />
          <a
            href="/browse"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium"
          >
            Browse
          </a>
          <span className="hidden text-sm text-slate-500 sm:inline">{userName}</span>
          <form action="/auth/signout" method="post">
            <button className="rounded border border-slate-300 px-3 py-1.5 text-sm">Sign out</button>
          </form>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Mobile drawer backdrop */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <aside
          className={`w-72 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white p-4 ${
            sidebarOpen ? "fixed inset-y-0 left-0 z-40 flex" : "hidden"
          } ${desktopSidebarCollapsed ? "md:hidden" : "md:static md:z-auto md:flex"}`}
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-bold">Recent Meetings</h2>
            <button
              onClick={() => setSidebarOpen(false)}
              className="rounded p-1 text-slate-500 hover:bg-slate-100 md:hidden"
              aria-label="Close menu"
            >
              ✕
            </button>
          </div>

          <ProjectFilterDropdown
            projects={projects}
            value={projectFilter}
            onChange={setProjectFilter}
            className="mb-4"
          />

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
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

        <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
