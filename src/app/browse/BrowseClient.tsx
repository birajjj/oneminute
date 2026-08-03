"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ProjectFilterDropdown from "@/components/ProjectFilterDropdown";
import { TagChips, TagBadges } from "@/components/TagChips";

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
  tags: string[];
  // If set, this minute was raised under another item during a follow-up; Browse
  // groups it beneath that item in the meeting it was raised.
  raisedFromRootId: string | null;
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
  assignedTo: string | null;
  tags: string[];
}

const STATUS_OPTIONS = ["New", "Initiated", "In Progress", "Completed", "Cancelled"];

// Colour per minute type, for the small type badge on raised sub-minutes.
const TYPE_BADGE: Record<string, string> = {
  Note: "bg-slate-100 text-slate-600",
  "To-Do": "bg-blue-100 text-blue-700",
  Action: "bg-emerald-100 text-emerald-700",
  Devops: "bg-orange-100 text-orange-700"
};

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
  members,
  userName,
  devopsBaseUrl,
  initialMeetingId
}: {
  meetings: BrowseMeeting[];
  projects: BrowseProject[];
  threads: Record<string, ThreadEntry[]>;
  members: { id: string; displayName: string }[];
  userName: string;
  devopsBaseUrl: string;
  initialMeetingId?: string | null;
}) {
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialMeetingId ?? meetings[0]?.id ?? null
  );
  const [search, setSearch] = useState("");
  // Flag filter (Decision/Scope/Governance). Both search and flags narrow the
  // meeting list AND the minutes shown, so it's declared up here with search.
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [openThreadRoot, setOpenThreadRoot] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<ThreadEntry | null>(null);
  const [openDevopsId, setOpenDevopsId] = useState<number | null>(null);
  const router = useRouter();

  // Optimistic inline edits, keyed by the ROOT minute id (an item's live status
  // / assignee lives on its thread root). saveMinute updates immediately and
  // reverts on failure.
  const [edits, setEdits] = useState<
    Record<string, { status?: string; assignedTo?: string | null; title?: string; description?: string | null; tags?: string[] }>
  >({});
  const [saveError, setSaveError] = useState("");

  // Click-to-edit for a minute's title + description.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", description: "", origTitle: "", origDescription: "" });
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  async function saveMinute(
    id: string,
    patch: { status?: string; assignedTo?: string | null; title?: string; description?: string | null; tags?: string[] }
  ) {
    const prev = edits[id];
    setSaveError("");
    setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }));
    try {
      const body: Record<string, string | string[]> = {};
      if (patch.status !== undefined) body.status = patch.status;
      if (patch.assignedTo !== undefined) body.assignedTo = patch.assignedTo ?? "";
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.description !== undefined) body.description = patch.description ?? "";
      if (patch.tags !== undefined) body.tags = patch.tags;
      const res = await fetch(`/api/minutes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      setEdits((cur) => ({ ...cur, [id]: prev ?? {} })); // revert
      setSaveError("Couldn't save change: " + (err instanceof Error ? err.message : "error"));
    }
  }

  // ---- Delete a meeting (guarded: only once nothing depends on it) ----
  const [confirmDelete, setConfirmDelete] = useState<BrowseMeeting | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [blockedBy, setBlockedBy] = useState<{ followUps: string[]; dependentMinutes: number } | null>(null);

  async function deleteMeeting(m: BrowseMeeting) {
    setDeleting(true);
    setBlockedBy(null);
    try {
      const res = await fetch(`/api/meetings/${m.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setBlockedBy({
          followUps: data.followUps ?? [],
          dependentMinutes: data.dependentMinutes ?? 0
        });
        return;
      }
      if (!res.ok) throw new Error(data.error || String(res.status));
      setConfirmDelete(null);
      if (selectedId === m.id) setSelectedId(null);
      router.refresh();
    } catch (err) {
      setSaveError("Couldn't delete meeting: " + (err instanceof Error ? err.message : "error"));
      setConfirmDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  // ---- Area/tab: drag-and-drop re-filing + rename ----
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverArea, setDragOverArea] = useState<string | null>(null);
  const [renamingArea, setRenamingArea] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  async function moveMinuteToArea(minuteId: string, area: string) {
    setSaveError("");
    try {
      const res = await fetch(`/api/minutes/${minuteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area })
      });
      if (!res.ok) throw new Error(await res.text());
      router.refresh();
    } catch (err) {
      setSaveError("Couldn't move minute: " + (err instanceof Error ? err.message : "error"));
    }
  }

  async function renameArea(from: string, to: string) {
    setRenamingArea(null);
    const name = to.trim();
    if (!name || name === from || !selected) return;
    setSaveError("");
    try {
      const res = await fetch(`/api/meetings/${selected.id}/areas`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: name })
      });
      if (!res.ok) throw new Error(await res.text());
      if (activeArea === from) setActiveArea(name);
      router.refresh();
    } catch (err) {
      setSaveError("Couldn't rename area: " + (err instanceof Error ? err.message : "error"));
    }
  }

  function startEditMinute(id: string, title: string, description: string) {
    setEditingId(id);
    setDraft({ title, description, origTitle: title, origDescription: description });
  }
  function commitEditMinute() {
    const id = editingId;
    if (!id) return;
    setEditingId(null);
    const changed =
      draft.title.trim() !== draft.origTitle.trim() || draft.description !== draft.origDescription;
    if (changed) {
      saveMinute(id, { title: draft.title.trim() || draft.origTitle, description: draft.description });
      setSavedFlash(id);
      window.setTimeout(() => setSavedFlash((f) => (f === id ? null : f)), 1500);
    }
  }

  // Click-to-edit for the meeting's own details (title / description / attendees).
  const [editingMeeting, setEditingMeeting] = useState<string | null>(null);
  const [mDraft, setMDraft] = useState({
    title: "", description: "", attendee: "", origTitle: "", origDescription: "", origAttendee: ""
  });
  const [mSaved, setMSaved] = useState(false);

  function startEditMeeting(m: BrowseMeeting) {
    setEditingMeeting(m.id);
    setMDraft({
      title: m.title,
      description: m.description ?? "",
      attendee: m.attendee ?? "",
      origTitle: m.title,
      origDescription: m.description ?? "",
      origAttendee: m.attendee ?? ""
    });
  }
  async function commitEditMeeting() {
    const id = editingMeeting;
    if (!id) return;
    setEditingMeeting(null);
    const changed =
      mDraft.title.trim() !== mDraft.origTitle.trim() ||
      mDraft.description !== mDraft.origDescription ||
      mDraft.attendee !== mDraft.origAttendee;
    if (!changed) return;
    try {
      const res = await fetch(`/api/meetings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: mDraft.title, description: mDraft.description, attendee: mDraft.attendee })
      });
      if (!res.ok) throw new Error(await res.text());
      setMSaved(true);
      window.setTimeout(() => setMSaved(false), 1500);
      router.refresh();
    } catch (e) {
      setSaveError("Couldn't save meeting: " + (e instanceof Error ? e.message : "error"));
    }
  }

  // ---- Unified search + flag filtering ----
  // Both narrow the sidebar (which meetings) and the main area (which minutes).
  const q = search.trim().toLowerCase();
  const textActive = q.length > 0;
  const flagActive = tagFilter.length > 0;
  const filterActive = textActive || flagActive;

  const minuteFlagged = (mn: BrowseMinute) =>
    (edits[mn.id]?.tags ?? mn.tags ?? []).some((t) => tagFilter.includes(t));
  const minuteText = (mn: BrowseMinute) =>
    mn.title.toLowerCase().includes(q) || (mn.description ?? "").toLowerCase().includes(q);

  const filteredMeetings = useMemo(() => {
    let list = meetings;
    if (projectFilter !== "all") {
      list = list.filter((m) => m.projectId === projectFilter);
    }
    if (textActive) {
      list = list.filter(
        (m) =>
          m.title.toLowerCase().includes(q) ||
          m.projectName.toLowerCase().includes(q) ||
          m.minutes.some(minuteText)
      );
    }
    if (flagActive) {
      list = list.filter((m) => m.minutes.some(minuteFlagged));
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetings, projectFilter, q, textActive, flagActive, tagFilter, edits]);

  // Keep the current meeting only if it survived the filter; otherwise show the
  // first match (so a search that excludes the open meeting doesn't leave it
  // stuck on screen).
  const selected = useMemo(() => {
    const byId = meetings.find((m) => m.id === selectedId) ?? null;
    if (byId && filteredMeetings.some((m) => m.id === byId.id)) return byId;
    return filteredMeetings[0] ?? null;
  }, [meetings, selectedId, filteredMeetings]);

  // Does the selected meeting match the text by its own title (not its minutes)?
  // If so, don't blank its minutes just because none contain the term.
  const selectedTitleMatched =
    !!selected && textActive &&
    (selected.title.toLowerCase().includes(q) || selected.projectName.toLowerCase().includes(q));

  // A minute passes the main-area filter.
  const minutePasses = (mn: BrowseMinute) => {
    if (flagActive && !minuteFlagged(mn)) return false;
    if (textActive && !minuteText(mn) && !selectedTitleMatched) return false;
    return true;
  };

  // Areas present in the selected meeting (tabs) — only those with visible minutes.
  const areas = useMemo(() => {
    if (!selected) return [];
    const set = new Set<string>();
    selected.minutes.forEach((m) => {
      if (!m.raisedFromRootId && minutePasses(m)) set.add(m.area || "General");
    });
    if (set.size === 0 && !filterActive) set.add("General");
    return Array.from(set);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, filterActive, q, textActive, flagActive, tagFilter, edits, selectedTitleMatched]);

  const [activeArea, setActiveArea] = useState<string>("General");
  const currentArea = areas.includes(activeArea) ? activeArea : areas[0] ?? "General";

  // Minutes raised under another item this meeting are shown nested beneath that
  // item's card, not as standalone cards — group them by the item they came from.
  const raisedByRoot = useMemo(() => {
    const map: Record<string, BrowseMinute[]> = {};
    if (!selected) return map;
    for (const m of selected.minutes) {
      if (m.raisedFromRootId) (map[m.raisedFromRootId] ??= []).push(m);
    }
    return map;
  }, [selected]);

  const areaMinutes = selected
    ? selected.minutes.filter(
        (m) => (m.area || "General") === currentArea && !m.raisedFromRootId && minutePasses(m)
      )
    : [];
  const isEditingMeeting = !!selected && editingMeeting === selected.id;

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      {/* Header */}
      <header className="shrink-0 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <h1 className="text-xl font-bold">Meeting Minutes</h1>
        <div className="flex items-center gap-3">
          <div className="relative">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search notes…"
              className="w-64 rounded-full border border-slate-300 px-4 py-1.5 pr-8 text-sm"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                title="Clear search"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <a
            href="/auto"
            className="rounded bg-gradient-to-r from-brand-pink to-brand-purple px-3 py-1.5 text-sm font-medium text-white"
          >
            + New Meeting
          </a>
          <span className="text-sm text-slate-500">{userName}</span>
          <form action="/auth/signout" method="post">
            <button className="rounded border border-slate-300 px-3 py-1.5 text-sm">Sign out</button>
          </form>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-lg font-bold">Recent Meetings</h2>

          <ProjectFilterDropdown
            projects={projects}
            value={projectFilter}
            onChange={setProjectFilter}
            className="mb-3"
          />

          {/* Flag filter — grouped with the project filter. Click a flag to list
              every minute carrying it across meetings; click again to clear. */}
          <div className="mb-4">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Filter by flag
            </div>
            <TagChips value={tagFilter} onChange={setTagFilter} />
          </div>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
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
        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          {!selected ? (
            <p className="text-slate-500">
              {filterActive ? "No meetings match the current filter." : "Select a meeting."}
            </p>
          ) : (
            <>
              {/* Meeting detail card — click title/description/attendees to edit */}
              <div
                className="mb-6 rounded-lg border border-slate-200 bg-white p-5"
                onBlur={(e) => {
                  if (isEditingMeeting && !e.currentTarget.contains(e.relatedTarget as Node)) commitEditMeeting();
                }}
                onKeyDown={(e) => {
                  if (isEditingMeeting && e.key === "Escape") setEditingMeeting(null);
                }}
              >
                <div className="flex items-center gap-2">
                  {isEditingMeeting ? (
                    <input
                      autoFocus
                      value={mDraft.title}
                      onChange={(e) => setMDraft((d) => ({ ...d, title: e.target.value }))}
                      className="w-full rounded border border-brand-blue px-2 py-1 text-xl font-semibold"
                    />
                  ) : (
                    <h2
                      onClick={() => startEditMeeting(selected)}
                      className="cursor-text text-xl font-semibold hover:underline"
                      title="Click to edit"
                    >
                      {selected.title}
                    </h2>
                  )}
                  {mSaved && <span className="text-[10px] font-medium text-emerald-600">Saved ✓</span>}
                  <button
                    onClick={() => { setBlockedBy(null); setConfirmDelete(selected); }}
                    className="ml-auto shrink-0 rounded px-2 py-1 text-slate-300 transition hover:bg-red-50 hover:text-red-600"
                    title="Delete this meeting"
                  >
                    🗑
                  </button>
                </div>
                <div className="mt-0.5 text-sm text-slate-500">{fmtDate(selected.date)}</div>

                <div className="mt-4 text-sm">
                  <div className="text-slate-500">Project:</div>
                  <div className="font-medium">{selected.projectName}</div>
                </div>

                <div className="mt-3 text-sm">
                  <div className="text-slate-500">Description:</div>
                  {isEditingMeeting ? (
                    <textarea
                      value={mDraft.description}
                      onChange={(e) => setMDraft((d) => ({ ...d, description: e.target.value }))}
                      rows={3}
                      className="mt-1 w-full rounded border border-brand-blue p-2 text-slate-700"
                    />
                  ) : (
                    <div
                      onClick={() => startEditMeeting(selected)}
                      className="mt-1 cursor-text rounded border border-slate-100 bg-slate-50 px-3 py-2 text-slate-700 hover:border-slate-200"
                    >
                      {selected.description || <span className="text-slate-400">—</span>}
                    </div>
                  )}
                </div>

                <div className="mt-3 text-sm">
                  <div className="text-slate-500">Attendees:</div>
                  {isEditingMeeting ? (
                    <input
                      value={mDraft.attendee}
                      onChange={(e) => setMDraft((d) => ({ ...d, attendee: e.target.value }))}
                      className="mt-1 w-full rounded border border-brand-blue px-2 py-1 text-slate-700"
                    />
                  ) : (
                    <div
                      onClick={() => startEditMeeting(selected)}
                      className="cursor-text font-medium hover:underline"
                      title="Click to edit"
                    >
                      {selected.attendee || <span className="text-slate-400">—</span>}
                    </div>
                  )}
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

                <div className="mt-4 flex items-center gap-2">
                  <a
                    href={`/followup?parent=${selected.id}`}
                    className="rounded bg-gradient-to-r from-amber-500 to-brand-purple px-4 py-2 text-sm font-medium text-white"
                  >
                    ↪ Follow up this meeting
                  </a>
                  <button className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white opacity-60" disabled title="Coming soon">
                    📄 Generate Report
                  </button>
                </div>
              </div>

              {/* Area tabs — sticky so they stay on screen while scrolling a long
                  list, and act as drop targets for dragging minutes between tabs.
                  Double-click a tab to rename it. */}
              <div className="sticky top-0 z-20 -mx-6 mb-4 border-b border-slate-200 bg-slate-50/95 px-6 py-2 backdrop-blur">
                <div className="flex flex-wrap items-center gap-2">
                  {areas.map((a) =>
                    renamingArea === a ? (
                      <input
                        key={a}
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => renameArea(a, renameDraft)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") renameArea(a, renameDraft);
                          if (e.key === "Escape") setRenamingArea(null);
                        }}
                        className="w-40 rounded border border-brand-blue px-2 py-1 text-sm"
                      />
                    ) : (
                      <button
                        key={a}
                        onClick={() => setActiveArea(a)}
                        onDoubleClick={() => { setRenamingArea(a); setRenameDraft(a); }}
                        onDragOver={(e) => { e.preventDefault(); setDragOverArea(a); }}
                        onDragLeave={() => setDragOverArea((c) => (c === a ? null : c))}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragOverArea(null);
                          if (draggingId) moveMinuteToArea(draggingId, a);
                          setDraggingId(null);
                        }}
                        title="Click to open · Double-click to rename (applies across the project) · Drop a minute here to move it"
                        className={`rounded px-4 py-1.5 text-sm font-medium transition ${
                          dragOverArea === a
                            ? "bg-emerald-100 text-emerald-700 ring-2 ring-emerald-400"
                            : currentArea === a
                              ? "bg-blue-100 text-brand-blue"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}
                      >
                        {a}
                      </button>
                    )
                  )}
                  <span className="ml-1 text-[11px] text-slate-400">
                    Drag a minute onto a tab to move it · double-click a tab to rename it across the project
                  </span>
                </div>
              </div>

              {/* Minutes */}
              {areaMinutes.length === 0 ? (
                <p className="text-slate-500">No minutes available for this area.</p>
              ) : (
                <div className="space-y-3">
                  {areaMinutes.map((mn) => {
                    // A follow-up minute is shown with its ORIGINAL item as the
                    // header and the update nested underneath — so a follow-up
                    // meeting reads the same "item → its update" shape as the
                    // origin meeting. Root minutes are unchanged.
                    const rootEntry = mn.isFollowUp
                      ? (threads[mn.rootId] ?? []).find((e) => e.isRoot) ?? null
                      : null;
                    const selfEntry = mn.isFollowUp
                      ? (threads[mn.rootId] ?? []).find((e) => e.id === mn.id) ?? null
                      : null;

                    // Point-in-time: the card shows THIS entry's own recorded status
                    // /assignee (as of its meeting). Title/description are the item's
                    // identity (the root). So status/assignee edits target this entry;
                    // title/description edits target the item (root).
                    const entryId = mn.id;
                    const itemId = mn.rootId;
                    const headerTitle = (mn.isFollowUp && rootEntry?.title) || mn.title;
                    // Type belongs to the ITEM's identity (like its title) — an update
                    // to a To-Do is still a To-Do — so take it from the root.
                    const headerType = (mn.isFollowUp && rootEntry?.type) || mn.type;
                    const contextDescription = mn.isFollowUp ? rootEntry?.description ?? null : mn.description;
                    const devopsId = mn.isFollowUp ? rootEntry?.devopsItemId ?? null : mn.devopsItemId;

                    const effEntry = edits[entryId] ?? {};
                    const effItem = edits[itemId] ?? {};
                    const displayStatus = effEntry.status ?? mn.status;
                    const displayAssignee =
                      effEntry.assignedTo === undefined ? mn.assignedTo ?? "" : effEntry.assignedTo ?? "";
                    const displayTitle = effItem.title ?? headerTitle;
                    const displayDescription =
                      effItem.description !== undefined ? effItem.description : contextDescription;
                    // Point-in-time, like status: flags record what THIS meeting
                    // decided, so they come from (and save to) this entry.
                    const displayTags = effEntry.tags ?? mn.tags ?? [];
                    const isEditing = editingId === itemId;

                    // Nested history: only what existed UP TO the meeting being viewed
                    // (so an earlier meeting doesn't show later updates). The full
                    // journey is still in the thread popup.
                    const nestedRows: ThreadEntry[] = (
                      mn.isFollowUp
                        ? selfEntry ? [selfEntry] : []
                        : (threads[mn.rootId] ?? []).filter(
                            (e) => !e.isRoot && (!selected || e.date <= selected.date)
                          )
                      // Only show updates that carry a note — a note-less entry
                      // (e.g. a placeholder created when sub-items were raised, or a
                      // bare status change) would just be an empty row.
                    ).filter((e) => e.description?.trim());

                    const isOpenPending =
                      mn.isPersistent && displayStatus !== "Completed" && displayStatus !== "Cancelled";
                    return (
                      <div
                        key={mn.id}
                        draggable={!isEditing}
                        onDragStart={(e) => {
                          setDraggingId(mn.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => { setDraggingId(null); setDragOverArea(null); }}
                        className={`rounded-lg border-l-4 p-4 ${
                          mn.isFollowUp
                            ? "border-l-amber-500 bg-amber-50"
                            : "border-l-brand-blue bg-blue-50"
                        } ${draggingId === mn.id ? "opacity-50 ring-2 ring-brand-blue" : ""}`}
                      >
                        <div className="flex items-start justify-between">
                          <div
                            className="flex-1"
                            onBlur={(e) => {
                              // Click/tab out of the whole card → save (on-prem feel).
                              if (isEditing && !e.currentTarget.contains(e.relatedTarget as Node)) commitEditMinute();
                            }}
                            onKeyDown={(e) => {
                              if (isEditing && e.key === "Escape") setEditingId(null);
                            }}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              {isEditing ? (
                                <input
                                  autoFocus
                                  value={draft.title}
                                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                                  className="min-w-[12rem] flex-1 rounded border border-brand-blue px-1 py-0.5 text-sm font-semibold"
                                />
                              ) : (
                                <span
                                  onClick={() => startEditMinute(itemId, displayTitle, displayDescription ?? "")}
                                  className="cursor-text font-semibold text-brand-blue hover:underline"
                                  title="Click to edit"
                                >
                                  {displayTitle}
                                </span>
                              )}
                              {savedFlash === itemId && (
                                <span className="text-[10px] font-medium text-emerald-600">Saved ✓</span>
                              )}
                              <span className="text-xs italic text-slate-500">{headerType}</span>
                              <TagChips
                                value={displayTags}
                                onChange={(tags) => saveMinute(entryId, { tags })}
                              />
                              <select
                                value={displayStatus}
                                onChange={(e) => saveMinute(entryId, { status: e.target.value })}
                                className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] text-slate-600"
                                title="Change status"
                              >
                                {STATUS_OPTIONS.map((s) => (
                                  <option key={s} value={s}>{s}</option>
                                ))}
                              </select>
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
                              <select
                                value={displayAssignee}
                                onChange={(e) => saveMinute(entryId, { assignedTo: e.target.value })}
                                className="rounded border border-slate-300 bg-slate-50 px-1 py-0.5 text-[10px] text-slate-600"
                                title="Assign"
                              >
                                <option value="">👤 Unassigned</option>
                                {displayAssignee && !members.some((m) => m.displayName === displayAssignee) && (
                                  <option value={displayAssignee}>👤 {displayAssignee}</option>
                                )}
                                {members.map((m) => (
                                  <option key={m.id} value={m.displayName}>👤 {m.displayName}</option>
                                ))}
                              </select>
                              {devopsId && <DevopsBadge id={devopsId} baseUrl={devopsBaseUrl} onOpen={setOpenDevopsId} />}
                              {mn.dueDate && (
                                <span className="text-[11px] text-slate-400">
                                  Due {shortDate(mn.dueDate)}
                                </span>
                              )}
                            </div>
                            {isEditing ? (
                              <textarea
                                value={draft.description}
                                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                                rows={3}
                                placeholder="Description…"
                                className="mt-2 w-full rounded border border-brand-blue p-2 text-sm text-slate-700"
                              />
                            ) : (
                              displayDescription && (
                                <div
                                  onClick={() => startEditMinute(itemId, displayTitle, displayDescription ?? "")}
                                  className="mt-2 cursor-text rounded border border-white bg-white/60 px-3 py-2 text-sm text-slate-700 hover:border-slate-200"
                                >
                                  {displayDescription}
                                </div>
                              )
                            )}

                            {/* Nested update rows (on-prem style). Click a row for detail. */}
                            {nestedRows.length > 0 && (
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
                                  {nestedRows.map((fu) => {
                                    const open = fu.status !== "Completed" && fu.status !== "Cancelled";
                                    return (
                                      <tr
                                        key={fu.id}
                                        onClick={() => setOpenEntry(fu)}
                                        className={`cursor-pointer hover:bg-blue-50 ${open ? "" : "text-slate-400"}`}
                                      >
                                        <td className="border-b border-slate-100 px-3 py-1.5 text-brand-blue">
                                          {/* Note-less rows are filtered out upstream,
                                              so this is always the update's note. */}
                                          {fu.description?.trim()}
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
                            )}

                            {/* Minutes raised under this item this meeting — their
                                own trackable minutes, grouped here for provenance. */}
                            {(raisedByRoot[mn.rootId] ?? []).length > 0 && (
                              <div className="mt-3">
                                <div className="mb-1.5 flex items-center gap-2">
                                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                                    Raised this meeting
                                  </span>
                                  <span className="h-px flex-1 bg-slate-200" />
                                </div>
                                <div className="space-y-2">
                                  {(raisedByRoot[mn.rootId] ?? []).map((sub) => {
                                    const subStatus = edits[sub.id]?.status ?? sub.status;
                                    const subDone = subStatus === "Completed" || subStatus === "Cancelled";
                                    return (
                                      <div
                                        key={sub.id}
                                        className="rounded-md border border-slate-200 bg-white p-2.5 shadow-sm"
                                      >
                                        <div className="flex items-start gap-2">
                                          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${TYPE_BADGE[sub.type] ?? "bg-slate-100 text-slate-600"}`}>
                                            {sub.type}
                                          </span>
                                          <div className="min-w-0 flex-1">
                                            <div className={`text-sm font-medium ${subDone ? "text-slate-400 line-through" : "text-slate-800"}`}>
                                              {sub.title}
                                            </div>
                                            {sub.description && (
                                              <p className="mt-0.5 text-xs text-slate-500">{sub.description}</p>
                                            )}
                                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                              <TagBadges tags={edits[sub.id]?.tags ?? sub.tags} />
                                              {sub.devopsItemId && (
                                                <button
                                                  onClick={() => setOpenDevopsId(sub.devopsItemId)}
                                                  className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 hover:bg-orange-200"
                                                >
                                                  🔗 DevOps #{sub.devopsItemId}
                                                </button>
                                              )}
                                            </div>
                                          </div>
                                          <div className="flex shrink-0 items-center gap-1.5">
                                            <select
                                              value={subStatus}
                                              onChange={(e) => saveMinute(sub.id, { status: e.target.value })}
                                              className="rounded border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-slate-600"
                                              title="Status"
                                            >
                                              {STATUS_OPTIONS.map((s) => (
                                                <option key={s} value={s}>{s}</option>
                                              ))}
                                            </select>
                                            <select
                                              value={edits[sub.id]?.assignedTo ?? sub.assignedTo ?? ""}
                                              onChange={(e) => saveMinute(sub.id, { assignedTo: e.target.value })}
                                              className="max-w-[8rem] rounded border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-slate-600"
                                              title="Assignee"
                                            >
                                              <option value="">— Unassigned —</option>
                                              {members.map((mem) => (
                                                <option key={mem.id} value={mem.displayName}>{mem.displayName}</option>
                                              ))}
                                            </select>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                          {/* Click-based alternative to dragging (touch / precise moves) */}
                          <select
                            value=""
                            onChange={(e) => { if (e.target.value) moveMinuteToArea(mn.id, e.target.value); }}
                            className="ml-4 shrink-0 rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px] text-slate-500"
                            title="Move this minute to another area"
                          >
                            <option value="">Move to…</option>
                            {areas.filter((a) => a !== (mn.area || "General")).map((a) => (
                              <option key={a} value={a}>{a}</option>
                            ))}
                          </select>
                          {/* Mark As Complete only on follow-up minutes; new/root
                              minutes (e.g. in a fresh meeting) use the status dropdown. */}
                          {mn.isFollowUp && (
                            <label className="ml-4 flex shrink-0 items-center gap-1 text-xs text-slate-500">
                              <input
                                type="checkbox"
                                checked={displayStatus === "Completed"}
                                onChange={(e) =>
                                  // Point-in-time: sets THIS entry's status (no duplicate entry).
                                  saveMinute(entryId, { status: e.target.checked ? "Completed" : "New" })
                                }
                              />
                              Mark As Complete
                            </label>
                          )}
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
          onOpenDevops={setOpenDevopsId}
          onClose={() => setOpenThreadRoot(null)}
        />
      )}

      {/* Single follow-up detail dialog — editable */}
      {openEntry && (
        <EntryModal
          entry={openEntry}
          devopsBaseUrl={devopsBaseUrl}
          members={members}
          onOpenDevops={setOpenDevopsId}
          onSaved={() => router.refresh()}
          onClose={() => setOpenEntry(null)}
        />
      )}

      {/* Delete confirmation — shows exactly what will go, and refuses while
          later meetings still depend on this one. */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDelete(null)}>
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Delete this meeting?</h3>
            <p className="mt-2 text-sm text-slate-600">
              <span className="font-medium">{confirmDelete.title}</span> — {fmtDate(confirmDelete.date)}
            </p>

            {blockedBy ? (
              <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <p className="font-medium">Can&apos;t delete this one yet.</p>
                {blockedBy.followUps.length > 0 && (
                  <>
                    <p className="mt-1">
                      It has {blockedBy.followUps.length} follow-up meeting(s) built on top of it:
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {blockedBy.followUps.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                  </>
                )}
                {blockedBy.dependentMinutes > 0 && (
                  <p className="mt-1">
                    {blockedBy.dependentMinutes} later update(s) hang off this meeting&apos;s minutes.
                  </p>
                )}
                <p className="mt-2">Delete the follow-up meeting(s) first — newest first.</p>
              </div>
            ) : (
              <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                This permanently deletes the meeting and its{" "}
                <b>{confirmDelete.minutes.length} minute(s)</b>. This cannot be undone.
              </div>
            )}

            <div className="mt-4 flex items-center gap-2 border-t border-slate-200 pt-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="rounded border border-slate-300 px-4 py-1.5 text-sm"
              >
                Cancel
              </button>
              {!blockedBy && (
                <button
                  onClick={() => deleteMeeting(confirmDelete)}
                  disabled={deleting}
                  className="ml-auto rounded bg-red-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "Delete meeting"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* DevOps work-item detail popup */}
      {openDevopsId !== null && (
        <DevopsDetailModal id={openDevopsId} baseUrl={devopsBaseUrl} onClose={() => setOpenDevopsId(null)} />
      )}

      {/* Floating drop targets — visible while dragging no matter how far down the
          list you are, so you never have to scroll back up to reach the tabs. */}
      {draggingId && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-slate-300 bg-white/95 px-6 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-600">Drop into area:</span>
            {areas.map((a) => (
              <button
                key={a}
                onDragOver={(e) => { e.preventDefault(); setDragOverArea(a); }}
                onDragLeave={() => setDragOverArea((c) => (c === a ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverArea(null);
                  if (draggingId) moveMinuteToArea(draggingId, a);
                  setDraggingId(null);
                }}
                className={`rounded border-2 border-dashed px-4 py-2 text-sm font-medium transition ${
                  dragOverArea === a
                    ? "border-emerald-500 bg-emerald-100 text-emerald-700"
                    : "border-slate-300 bg-slate-50 text-slate-600"
                }`}
              >
                {a}
              </button>
            ))}
          </div>
        </div>
      )}

      {saveError && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded bg-red-600 px-4 py-2 text-sm text-white shadow-lg">
          <span>{saveError}</span>
          <button onClick={() => setSaveError("")} className="font-bold leading-none">×</button>
        </div>
      )}
    </div>
  );
}

// Clickable Azure DevOps work-item badge. Shown for both created and linked
// items (both store the same devopsItemId). Falls back to a non-link chip if we
// don't know the DevOps base URL.
function DevopsBadge({
  id,
  baseUrl,
  onOpen
}: {
  id: number;
  baseUrl: string;
  onOpen?: (id: number) => void;
}) {
  const cls = "rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-700";
  if (onOpen) {
    return (
      <button onClick={() => onOpen(id)} title="View DevOps details" className={`${cls} hover:bg-orange-200`}>
        🔗 DevOps #{id}
      </button>
    );
  }
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

interface WorkItemDetail {
  id: number;
  title: string | null;
  type: string | null;
  state: string | null;
  assignedTo: string | null;
  project: string | null;
  createdDate: string | null;
  changedDate: string | null;
  comments: { text: string; author: string | null; date: string | null }[];
}

// Fetches and shows a DevOps work item's live details + comments, with a link
// to open it in DevOps. Fetch failures (e.g. auth/PAT issues) surface inline.
function DevopsDetailModal({ id, baseUrl, onClose }: { id: number; baseUrl: string; onClose: () => void }) {
  const [detail, setDetail] = useState<WorkItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr("");
    setDetail(null);
    fetch(`/api/devops/workitem/${id}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || String(r.status));
        return data as WorkItemDetail;
      })
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const link = baseUrl ? `${baseUrl}/_workitems/edit/${id}` : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-orange-500">DevOps #{id}</div>
            <h3 className="text-lg font-bold">{detail?.title ?? (loading ? "Loading…" : "Work item")}</h3>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-slate-400 hover:text-slate-600">×</button>
        </div>

        {loading && <div className="text-sm text-slate-500">Loading DevOps details…</div>}
        {err && <div className="rounded bg-red-50 p-3 text-sm text-red-700">Couldn&apos;t load: {err}</div>}

        {detail && !loading && (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <div><span className="text-slate-500">Type:</span> {detail.type ?? "—"}</div>
              <div><span className="text-slate-500">Status:</span> {detail.state ?? "—"}</div>
              <div><span className="text-slate-500">Assigned to:</span> {detail.assignedTo ?? "Unassigned"}</div>
              <div><span className="text-slate-500">Project:</span> {detail.project ?? "—"}</div>
              <div><span className="text-slate-500">Created:</span> {detail.createdDate ? fmtDate(detail.createdDate) : "—"}</div>
              <div><span className="text-slate-500">Activity:</span> {detail.changedDate ? fmtDate(detail.changedDate) : "—"}</div>
            </div>

            <div className="mt-4">
              <div className="mb-1 text-xs font-semibold uppercase text-slate-500">
                Comments ({detail.comments.length})
              </div>
              {detail.comments.length === 0 ? (
                <div className="text-sm text-slate-400">No comments.</div>
              ) : (
                <ul className="space-y-2">
                  {detail.comments.map((c, i) => (
                    <li key={i} className="rounded border border-slate-100 bg-slate-50 p-2 text-sm">
                      <div className="whitespace-pre-wrap text-slate-700">{c.text}</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {c.author ?? "—"}{c.date ? ` · ${fmtDate(c.date)}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {link && (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="rounded bg-orange-100 px-3 py-1.5 text-sm font-medium text-orange-700 hover:bg-orange-200"
            >
              Open in DevOps ↗
            </a>
          </div>
        )}
      </div>
    </div>
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

// Editable detail dialog for a follow-up minute (opened from a nested row). Lets
// you edit that entry's text, status, and assignee, then Save. On save the page
// refreshes so the nested rows reflect the change.
function EntryModal({
  entry,
  devopsBaseUrl,
  members,
  onOpenDevops,
  onSaved,
  onClose
}: {
  entry: ThreadEntry;
  devopsBaseUrl: string;
  members: { id: string; displayName: string }[];
  onOpenDevops: (id: number) => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [description, setDescription] = useState(entry.description ?? "");
  const [status, setStatus] = useState(entry.status);
  const [assignedTo, setAssignedTo] = useState(entry.assignedTo ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const dirty =
    description !== (entry.description ?? "") ||
    status !== entry.status ||
    assignedTo !== (entry.assignedTo ?? "");

  async function save() {
    setSaving(true);
    setErr("");
    try {
      const res = await fetch(`/api/minutes/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, status, assignedTo })
      });
      if (!res.ok) throw new Error(await res.text());
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  const assigneeNames = members.map((m) => m.displayName);
  const extraAssignee = assignedTo && !assigneeNames.includes(assignedTo) ? [assignedTo] : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Edit follow-up minute
            </div>
            <h3 className="text-lg font-bold">{entry.title}</h3>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-slate-400 hover:text-slate-600">×</button>
        </div>

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="Details…"
          className="w-full rounded border border-slate-300 p-2 text-sm text-slate-700"
        />

        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded border border-slate-300 p-1">
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Assignee</span>
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className="rounded border border-slate-300 p-1">
              <option value="">— Unassigned —</option>
              {extraAssignee.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
              {members.map((m) => (
                <option key={m.id} value={m.displayName}>{m.displayName}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded px-1.5 py-0.5 font-medium ${typeBadgeClass(entry.type)}`}>{entry.type}</span>
          {entry.devopsItemId && <DevopsBadge id={entry.devopsItemId} baseUrl={devopsBaseUrl} onOpen={onOpenDevops} />}
          <span className="text-slate-400">{entry.meetingTitle} · {fmtDate(entry.date)}</span>
        </div>

        {err && <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{err}</div>}

        <div className="mt-4 flex items-center gap-2 border-t border-slate-200 pt-3">
          <button onClick={onClose} disabled={saving} className="rounded border border-slate-300 px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="ml-auto rounded bg-brand-blue px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ThreadModal({
  entries,
  devopsBaseUrl,
  onOpenDevops,
  onClose
}: {
  entries: ThreadEntry[];
  devopsBaseUrl: string;
  onOpenDevops: (id: number) => void;
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
                  {e.devopsItemId && <DevopsBadge id={e.devopsItemId} baseUrl={devopsBaseUrl} onOpen={onOpenDevops} />}
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
