"use client";

import { useMemo, useState } from "react";

export interface BrowseMinute {
  id: string;
  area: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  isFollowUp: boolean;
  isPersistent: boolean;
  assignedTo: string | null;
  dueDate: string | null;
}

export interface BrowseMeeting {
  id: string;
  title: string;
  date: string;
  projectId: string;
  projectName: string;
  description: string | null;
  attendee: string | null;
  followUpFrom: { title: string; date: string } | null;
  minutes: BrowseMinute[];
}

export interface BrowseProject {
  id: string;
  name: string;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-AU", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }) + ", " + d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

function shortDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  return `${dd}/${mm}/${yy}`;
}

export default function BrowseClient({
  meetings,
  projects,
  userName
}: {
  meetings: BrowseMeeting[];
  projects: BrowseProject[];
  userName: string;
}) {
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(meetings[0]?.id ?? null);
  const [search, setSearch] = useState("");

  const filteredMeetings = useMemo(() => {
    let list = meetings;
    if (projectFilter !== "all") {
      list = list.filter((m) => m.projectId === projectFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (m) =>
          m.title.toLowerCase().includes(q) ||
          m.projectName.toLowerCase().includes(q) ||
          m.minutes.some((mn) => mn.title.toLowerCase().includes(q))
      );
    }
    return list;
  }, [meetings, projectFilter, search]);

  const selected = useMemo(
    () => meetings.find((m) => m.id === selectedId) ?? filteredMeetings[0] ?? null,
    [meetings, selectedId, filteredMeetings]
  );

  // Areas present in the selected meeting (tabs)
  const areas = useMemo(() => {
    if (!selected) return [];
    const set = new Set<string>();
    selected.minutes.forEach((m) => set.add(m.area || "General"));
    if (set.size === 0) set.add("General");
    return Array.from(set);
  }, [selected]);

  const [activeArea, setActiveArea] = useState<string>("General");
  const currentArea = areas.includes(activeArea) ? activeArea : areas[0] ?? "General";

  const areaMinutes = selected
    ? selected.minutes.filter((m) => (m.area || "General") === currentArea)
    : [];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
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
            href="/auto"
            className="rounded bg-gradient-to-r from-brand-pink to-brand-purple px-3 py-1.5 text-sm font-medium text-white"
          >
            + Capture (Auto)
          </a>
          <span className="text-sm text-slate-500">{userName}</span>
          <form action="/auth/signout" method="post">
            <button className="rounded border border-slate-300 px-3 py-1.5 text-sm">Sign out</button>
          </form>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
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
            {filteredMeetings.length === 0 && (
              <p className="text-sm text-slate-400">No meetings.</p>
            )}
            {filteredMeetings.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedId(m.id)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  selected?.id === m.id
                    ? "border-brand-blue bg-blue-50"
                    : "border-slate-200 bg-slate-50 hover:bg-slate-100"
                }`}
              >
                <div className="font-semibold text-brand-blue">{m.title}</div>
                <div className="text-xs text-slate-500">{fmtDate(m.date)}</div>
                <div className="text-xs text-slate-500">{m.projectName}</div>
              </button>
            ))}
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 p-6">
          {!selected ? (
            <p className="text-slate-500">Select a meeting.</p>
          ) : (
            <>
              {/* Meeting detail card */}
              <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
                <h2 className="text-xl font-semibold">{selected.title}</h2>
                <div className="mt-0.5 text-sm text-slate-500">{fmtDate(selected.date)}</div>

                <div className="mt-4 text-sm">
                  <div className="text-slate-500">Project:</div>
                  <div className="font-medium">{selected.projectName}</div>
                </div>

                <div className="mt-3 text-sm">
                  <div className="text-slate-500">Description:</div>
                  <div className="mt-1 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-slate-700">
                    {selected.description || <span className="text-slate-400">—</span>}
                  </div>
                </div>

                <div className="mt-3 text-sm">
                  <div className="text-slate-500">Attendees:</div>
                  <div className="font-medium">{selected.attendee || <span className="text-slate-400">—</span>}</div>
                </div>

                {selected.followUpFrom && (
                  <div className="mt-3 text-sm">
                    <span className="text-slate-500">Follow-up From: </span>
                    <span className="font-medium text-brand-blue">
                      {selected.followUpFrom.title}
                      {selected.followUpFrom.date ? ` — ${fmtDate(selected.followUpFrom.date)}` : ""}
                    </span>
                  </div>
                )}

                <button className="mt-4 rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white opacity-60" disabled title="Coming soon">
                  📄 Generate Report
                </button>
              </div>

              {/* Area tabs */}
              <div className="mb-4 flex items-center gap-2">
                {areas.map((a) => (
                  <button
                    key={a}
                    onClick={() => setActiveArea(a)}
                    className={`rounded px-4 py-1.5 text-sm font-medium ${
                      currentArea === a
                        ? "bg-blue-100 text-brand-blue"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>

              {/* Minutes */}
              {areaMinutes.length === 0 ? (
                <p className="text-slate-500">No minutes available for this area.</p>
              ) : (
                <div className="space-y-3">
                  {areaMinutes.map((mn) => (
                    <div
                      key={mn.id}
                      className={`rounded-lg border-l-4 p-4 ${
                        mn.isFollowUp
                          ? "border-l-amber-500 bg-amber-50"
                          : "border-l-brand-blue bg-blue-50"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-brand-blue">{mn.title}</span>
                            <span className="text-xs italic text-slate-500">{mn.type}</span>
                            <span className="rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-500">
                              {mn.status}
                            </span>
                            {mn.isPersistent && (
                              <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] text-purple-700">
                                persists
                              </span>
                            )}
                            {mn.dueDate && (
                              <span className="text-[11px] text-slate-400">
                                Due {shortDate(mn.dueDate)}
                              </span>
                            )}
                          </div>
                          {mn.description && (
                            <div className="mt-2 rounded border border-white bg-white/60 px-3 py-2 text-sm text-slate-700">
                              {mn.description}
                            </div>
                          )}
                        </div>
                        <label className="ml-4 flex shrink-0 items-center gap-1 text-xs text-slate-500">
                          <input type="checkbox" disabled checked={mn.status === "Completed"} />
                          Mark As Complete
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
