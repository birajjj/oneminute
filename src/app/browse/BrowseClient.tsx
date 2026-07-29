"use client";

import { useMemo, useState } from "react";

export interface BrowseMinute {
  id: string;
  rootId: string;
  area: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  isFollowUp: boolean;
  isPersistent: boolean;
  threadCount: number;
  assignedTo: string | null;
  dueDate: string | null;
  devopsItemId: number | null;
}

export interface ThreadEntry {
  id: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  date: string;
  meetingTitle: string;
  isRoot: boolean;
  devopsItemId: number | null;
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
  threads,
  userName,
  devopsBaseUrl
}: {
  meetings: BrowseMeeting[];
  projects: BrowseProject[];
  threads: Record<string, ThreadEntry[]>;
  userName: string;
  devopsBaseUrl: string;
}) {
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(meetings[0]?.id ?? null);
  const [search, setSearch] = useState("");
  const [openThreadRoot, setOpenThreadRoot] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<ThreadEntry | null>(null);

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
                  {areaMinutes.map((mn) => {
                    const isOpenPending =
                      mn.isPersistent && mn.status !== "Completed" && mn.status !== "Cancelled";
                    return (
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
                              <button
                                onClick={() => setOpenThreadRoot(mn.rootId)}
                                className="font-semibold text-brand-blue hover:underline"
                                title="View full history of this item"
                              >
                                {mn.title}
                              </button>
                              <span className="text-xs italic text-slate-500">{mn.type}</span>
                              <span className="rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-500">
                                {mn.status}
                              </span>
                              {isOpenPending && (
                                <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                                  ● pending
                                </span>
                              )}
                              {mn.threadCount > 1 && (
                                <button
                                  onClick={() => setOpenThreadRoot(mn.rootId)}
                                  className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 hover:bg-indigo-200"
                                >
                                  🔗 {mn.threadCount} in thread
                                </button>
                              )}
                              {mn.assignedTo && (
                                <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600">
                                  👤 {mn.assignedTo}
                                </span>
                              )}
                              {mn.devopsItemId && (
                                <DevopsBadge id={mn.devopsItemId} baseUrl={devopsBaseUrl} />
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

                            {/* Nested follow-up updates (on-prem style): shown under
                                the original minute. Click a row to open the detail. */}
                            {!mn.isFollowUp && (() => {
                              const followUps = (threads[mn.rootId] ?? []).filter((e) => !e.isRoot);
                              if (followUps.length === 0) return null;
                              return (
                                <table className="mt-2 w-full border-collapse overflow-hidden rounded border border-slate-200 bg-white text-left text-sm">
                                  <thead>
                                    <tr className="bg-slate-50 text-xs text-slate-500">
                                      <th className="border-b border-slate-200 px-3 py-1.5 font-medium">Follow-up</th>
                                      <th className="border-b border-slate-200 px-3 py-1.5 font-medium">Type</th>
                                      <th className="border-b border-slate-200 px-3 py-1.5 font-medium">Status</th>
                                      <th className="border-b border-slate-200 px-3 py-1.5 font-medium">Date</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {followUps.map((fu) => {
                                      const open = fu.status !== "Completed" && fu.status !== "Cancelled";
                                      return (
                                        <tr
                                          key={fu.id}
                                          onClick={() => setOpenEntry(fu)}
                                          className={`cursor-pointer hover:bg-blue-50 ${open ? "" : "text-slate-400"}`}
                                        >
                                          <td className="border-b border-slate-100 px-3 py-1.5 text-brand-blue">
                                            {fu.description?.trim() || fu.title}
                                          </td>
                                          <td className="border-b border-slate-100 px-3 py-1.5">{fu.type}</td>
                                          <td className="border-b border-slate-100 px-3 py-1.5">
                                            {fu.status}
                                            {open && (fu.type === "Action" || fu.type === "To-Do" || fu.type === "Devops") && (
                                              <span className="ml-1 rounded bg-amber-200 px-1 text-[9px] font-semibold text-amber-800">open</span>
                                            )}
                                          </td>
                                          <td className="border-b border-slate-100 px-3 py-1.5 text-slate-500">{shortDate(fu.date)}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              );
                            })()}
                          </div>
                          <label className="ml-4 flex shrink-0 items-center gap-1 text-xs text-slate-500">
                            <input type="checkbox" disabled checked={mn.status === "Completed"} />
                            Mark As Complete
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* Thread history modal */}
      {openThreadRoot && (
        <ThreadModal
          entries={threads[openThreadRoot] ?? []}
          devopsBaseUrl={devopsBaseUrl}
          onClose={() => setOpenThreadRoot(null)}
        />
      )}

      {/* Single follow-up detail dialog (opened from a nested table row) */}
      {openEntry && (
        <EntryModal entry={openEntry} devopsBaseUrl={devopsBaseUrl} onClose={() => setOpenEntry(null)} />
      )}
    </div>
  );
}

// Clickable Azure DevOps work-item badge. Shown for both created and linked
// items (both store the same devopsItemId). Falls back to a non-link chip if we
// don't know the DevOps base URL.
function DevopsBadge({ id, baseUrl }: { id: number; baseUrl: string }) {
  const cls = "rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-700";
  if (!baseUrl) return <span className={cls}>🔗 DevOps #{id}</span>;
  return (
    <a
      href={`${baseUrl}/_workitems/edit/${id}`}
      target="_blank"
      rel="noreferrer"
      title="Open this work item in Azure DevOps"
      className={`${cls} hover:bg-orange-200`}
    >
      🔗 DevOps #{id}
    </a>
  );
}

function typeBadgeClass(type: string): string {
  switch (type) {
    case "Action":
      return "bg-blue-100 text-blue-700";
    case "To-Do":
      return "bg-emerald-100 text-emerald-700";
    case "Devops":
      return "bg-orange-100 text-orange-700";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

function EntryModal({
  entry,
  devopsBaseUrl,
  onClose
}: {
  entry: ThreadEntry;
  devopsBaseUrl: string;
  onClose: () => void;
}) {
  const open = entry.status !== "Completed" && entry.status !== "Cancelled";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Follow-up minute
            </div>
            <h3 className="text-lg font-bold">{entry.title}</h3>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-slate-400 hover:text-slate-600">×</button>
        </div>

        <div className="whitespace-pre-wrap rounded border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {entry.description || <span className="italic text-slate-400">(no details recorded)</span>}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded px-1.5 py-0.5 font-medium ${typeBadgeClass(entry.type)}`}>{entry.type}</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{entry.status}</span>
          {open && (
            <span className="rounded bg-amber-200 px-1.5 py-0.5 font-semibold text-amber-800">● still open</span>
          )}
          {entry.devopsItemId && <DevopsBadge id={entry.devopsItemId} baseUrl={devopsBaseUrl} />}
          <span className="text-slate-400">{entry.meetingTitle} · {fmtDate(entry.date)}</span>
        </div>
      </div>
    </div>
  );
}

function ThreadModal({
  entries,
  devopsBaseUrl,
  onClose
}: {
  entries: ThreadEntry[];
  devopsBaseUrl: string;
  onClose: () => void;
}) {
  const rootTitle = entries.find((e) => e.isRoot)?.title ?? entries[entries.length - 1]?.title ?? "Thread";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Thread history ({entries.length})
            </div>
            <h3 className="text-lg font-bold">{rootTitle}</h3>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-slate-400 hover:text-slate-600">
            ×
          </button>
        </div>

        <div className="space-y-4">
          {entries.map((e, i) => {
            // The thread title is shown once in the header. Only repeat a per-entry
            // title when an update changed the wording from the root title.
            const showEntryTitle = e.title.trim() !== rootTitle.trim();
            return (
              <div key={e.id} className={i < entries.length - 1 ? "border-b border-slate-100 pb-4" : ""}>
                {showEntryTitle && (
                  <div className="mb-1 font-semibold text-slate-800">{e.title}</div>
                )}
                <div className="whitespace-pre-wrap text-sm text-slate-700">
                  {e.description || <span className="italic text-slate-400">(no details recorded)</span>}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded px-1.5 py-0.5 font-medium ${typeBadgeClass(e.type)}`}>
                    {e.type}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{e.status}</span>
                  {e.isRoot && (
                    <span className="rounded bg-brand-blue px-1.5 py-0.5 text-white">original</span>
                  )}
                  {e.devopsItemId && <DevopsBadge id={e.devopsItemId} baseUrl={devopsBaseUrl} />}
                  <span className="text-slate-400">
                    {e.meetingTitle} · {fmtDate(e.date)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
