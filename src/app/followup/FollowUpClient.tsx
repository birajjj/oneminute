"use client";

import { useEffect, useMemo, useState } from "react";
import type { FollowUpData, OpenItem } from "@/lib/followup";
import { useSegmentRecorder } from "@/lib/useSegmentRecorder";
import { analyzeFollowupChunked } from "@/lib/chunk-analyze";
import { TagChips } from "@/components/TagChips";
import { normalizeTags } from "@/lib/tags";
import BusyOverlay from "@/components/BusyOverlay";
import MeetingAttachments from "@/components/MeetingAttachments";
import { downloadTranscript } from "@/lib/download-transcript";
import { writeGapsPayload, drainAccepted, GAPS_ACCEPTED_KEY } from "@/lib/gaps-handoff";

const TYPE_OPTIONS = ["Note", "To-Do", "Action", "Devops"];
// Types allowed for extra minutes raised under an open item (boss: note/todo/
// devops, not action).
// Sub-entries are actionable items raised under a review item. A plain note is
// redundant — the "What happened with this item?" box already captures that.
const SUB_TYPE_OPTIONS = ["To-Do", "Devops"];
const STATUS_OPTIONS = ["New", "Initiated", "In Progress", "Resolved", "Closed", "Cancelled"];

interface Member {
  id: string;
  displayName: string;
}

interface ItemUpdate {
  noUpdate: boolean;
  type: string;
  status: string;
  note: string;
  assignedTo: string;
  dueDate: string;
  tags: string[]; // governance flags — saved onto the ITEM, not this update
  subEntries: NewMinute[]; // extra note/to-do/devops raised under this item
  devopsAction: string; // none | create | link
  devopsProject: string;
  devopsWorkItemType: string; // User Story | Bug
  devopsWorkItemId: string;
}

interface NewMinute {
  // To-dos / devops raised under this new minute (one level deep).
  children?: NewMinute[];
  area: string;
  title: string;
  description: string;
  type: string;
  status: string;
  assignedTo: string;
  dueDate: string;
  tags: string[]; // governance flags
  devopsAction: string;
  devopsProject: string;
  devopsWorkItemType: string;
  devopsWorkItemId: string;
}

type DevopsPatch = Partial<
  Pick<ItemUpdate, "devopsAction" | "devopsProject" | "devopsWorkItemType" | "devopsWorkItemId">
>;

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" }) +
    ", " +
    d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })
  );
}

// A small grip you grab to drag. Module-level so it keeps a stable identity and
// never remounts mid-drag, and so it never interferes with the card's inputs.
function DragGrip({
  onStart,
  onEnd,
  label
}: {
  onStart: () => void;
  onEnd: () => void;
  label: string;
}) {
  return (
    <span
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        onStart();
      }}
      onDragEnd={onEnd}
      className="cursor-grab select-none px-1 text-slate-400 hover:text-slate-600"
      title={label}
      aria-label={label}
    >
      ⠿
    </span>
  );
}

// Local now as a datetime-local value (YYYY-MM-DDTHH:mm) for the date+time input.
function nowDateTimeInput(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A datetime-local value (the user's local wall clock) → a full ISO instant, so
// the server stores the exact moment and it renders correctly in their timezone.
function dateTimeLocalToISO(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// The follow-up title still uses just the date part.
function datePart(s: string): string {
  return s.slice(0, 10);
}

function buildFollowUpTitle(parentTitle: string, date: string): string {
  const base = stripFollowUpSuffixes(parentTitle) || parentTitle.trim() || "Follow-up Meeting";
  return `${base} - Follow-up ${date}`;
}

function stripFollowUpSuffixes(title: string): string {
  let current = title.trim();
  let previous = "";
  const suffix = /\s+(?:-|\u2013|\u2014)\s*Follow-up(?:\s+\d{4}-\d{2}-\d{2})?(?:\s+#\d+)?\s*$/i;

  while (current && current !== previous) {
    previous = current;
    current = current.replace(suffix, "").trim();
  }

  return current;
}

export default function FollowUpClient({
  data,
  members,
  devopsBaseUrl,
  devopsEnabled
}: {
  data: FollowUpData;
  members: Member[];
  devopsBaseUrl: string;
  devopsEnabled: boolean;
}) {
  const initialDate = nowDateTimeInput();
  const parentDisplayTitle = stripFollowUpSuffixes(data.parent.title) || data.parent.title;
  const [title, setTitle] = useState(() => buildFollowUpTitle(data.parent.title, datePart(initialDate)));
  const [date, setDate] = useState(initialDate);
  // AI recap of this follow-up meeting → becomes the meeting's description.
  const [aiSummary, setAiSummary] = useState("");

  const [updates, setUpdates] = useState<Record<string, ItemUpdate>>(() => {
    const init: Record<string, ItemUpdate> = {};
    for (const it of data.openItems) {
      init[it.id] = {
        noUpdate: false,
        type: it.type,
        status: it.status,
        note: "",
        assignedTo: it.assignedTo ?? "",
        dueDate: it.dueDate ? it.dueDate.slice(0, 10) : "",
        // Carried forward from the item's newest entry (same as status/assignee),
        // so you can see what's flagged and adjust it for this meeting.
        tags: it.tags ?? [],
        subEntries: [],
        devopsAction: "none",
        devopsProject: "",
        devopsWorkItemType: "User Story",
        devopsWorkItemId: ""
      };
    }
    return init;
  });

  // Sub-entries: add / edit / remove a to-do/devops under a given open item.
  function emptySub(): NewMinute {
    return {
      area: "", title: "", description: "", type: "To-Do", status: "New",
      assignedTo: "", dueDate: "", tags: [],
      devopsAction: "none", devopsProject: "", devopsWorkItemType: "User Story", devopsWorkItemId: ""
    };
  }
  function addSub(itemId: string) {
    setUpdates((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], subEntries: [...prev[itemId].subEntries, emptySub()] }
    }));
  }
  function setSub(itemId: string, i: number, patch: Partial<NewMinute>) {
    setUpdates((prev) => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        subEntries: prev[itemId].subEntries.map((s, idx) => (idx === i ? { ...s, ...patch } : s))
      }
    }));
  }
  function removeSub(itemId: string, i: number) {
    setUpdates((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], subEntries: prev[itemId].subEntries.filter((_, idx) => idx !== i) }
    }));
  }

  const [newMinutes, setNewMinutes] = useState<NewMinute[]>([]);

  // Suggestions accepted in the AI Recommendation tab arrive here live.
  useEffect(() => {
    function applyAccepted() {
      const items = drainAccepted();
      if (items.length === 0) return;
      setNewMinutes((prev) => [
        ...prev,
        ...items.map((it) => ({
          area: it.area || "General",
          title: it.title,
          description: it.description,
          type: it.minuteType,
          status: "New",
          assignedTo: "",
          dueDate: "",
          tags: [] as string[],
          devopsAction: "none",
          devopsProject: "",
          devopsWorkItemType: "User Story",
          devopsWorkItemId: ""
        }))
      ]);
    }
    function onStorage(e: StorageEvent) {
      if (e.key === GAPS_ACCEPTED_KEY && e.newValue) applyAccepted();
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", applyAccepted);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", applyAccepted);
    };
  }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ meetingId?: string; updated: number; created: number; warnings: string[] } | null>(null);

  // ---- Drag & drop reorganisation (additive — existing controls untouched) ----
  // Drag an item's grip handle; drop onto a tab (re-file) or onto another item
  // (nest / re-parent). Moving a committed open item re-files it in the DB now
  // (like Browse); moving a new minute / sub-entry is part of the draft.
  type DragItem =
    | { kind: "openItem"; id: string }
    | { kind: "newMinute"; index: number }
    | { kind: "subEntry"; parentId: string; index: number };
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dragOverArea, setDragOverArea] = useState<string | null>(null);
  const [dragOverItem, setDragOverItem] = useState<string | null>(null);
  const [areaOverride, setAreaOverride] = useState<Record<string, string>>({});

  function endDrag() {
    setDragItem(null);
    setDragOverArea(null);
    setDragOverItem(null);
  }

  // Re-file a committed open item to another tab — moves the whole thread, same
  // as Browse. Optimistic; reverts on failure.
  async function moveItemToArea(id: string, area: string) {
    setAreaOverride((o) => ({ ...o, [id]: area }));
    try {
      const res = await fetch(`/api/minutes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area })
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e) {
      setAreaOverride((o) => {
        const n = { ...o };
        delete n[id];
        return n;
      });
      setError("Couldn't move item: " + (e instanceof Error ? e.message : "error"));
    }
  }

  function onDropOnTab(area: string) {
    const d = dragItem;
    endDrag();
    if (!d) return;
    if (d.kind === "openItem") {
      const cur = areaOverride[d.id] ?? data.openItems.find((i) => i.id === d.id)?.area;
      if (cur !== area) moveItemToArea(d.id, area);
    } else if (d.kind === "newMinute") {
      setNewMinutes((prev) => prev.map((m, i) => (i === d.index ? { ...m, area } : m)));
    } else if (d.kind === "subEntry") {
      // Un-nest a sub-item back to a standalone new minute in that tab.
      const s = updates[d.parentId]?.subEntries[d.index];
      if (!s) return;
      setUpdates((prev) => ({
        ...prev,
        [d.parentId]: {
          ...prev[d.parentId],
          subEntries: prev[d.parentId].subEntries.filter((_, i) => i !== d.index)
        }
      }));
      setNewMinutes((prev) => [...prev, { ...s, area }]);
    }
  }

  function onDropOnItem(targetId: string) {
    const d = dragItem;
    endDrag();
    if (!d) return;
    if (d.kind === "newMinute") {
      const m = newMinutes[d.index];
      if (!m) return;
      setNewMinutes((prev) => prev.filter((_, i) => i !== d.index));
      setUpdates((prev) => ({
        ...prev,
        [targetId]: { ...prev[targetId], subEntries: [...prev[targetId].subEntries, m] }
      }));
    } else if (d.kind === "subEntry") {
      if (d.parentId === targetId) return;
      const s = updates[d.parentId]?.subEntries[d.index];
      if (!s) return;
      setUpdates((prev) => ({
        ...prev,
        [d.parentId]: {
          ...prev[d.parentId],
          subEntries: prev[d.parentId].subEntries.filter((_, i) => i !== d.index)
        },
        [targetId]: { ...prev[targetId], subEntries: [...prev[targetId].subEntries, s] }
      }));
    }
  }


  // Optional AI pre-fill: record → transcribe → map to the open items below.
  const recorder = useSegmentRecorder(`oneminute:followup:${data.parent.id}`);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [aiFilled, setAiFilled] = useState<Set<string>>(new Set());

  // Real DevOps projects for the "Create work item" dropdown (lazy, like Auto).
  const [devopsProjects, setDevopsProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!devopsEnabled) return;
    let cancelled = false;
    fetch("/api/devops/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.projects) setDevopsProjects(d.projects); })
      .catch(() => { /* leave empty -> free-text fallback */ });
    return () => { cancelled = true; };
  }, [devopsEnabled]);

  // Items raised under another item nest beneath that parent's editable block. A
  // Closed parent that still hosts an open child is now kept in data.openItems
  // (see followup.ts), so it renders as a normal editable item with the child
  // nested. The orphan branch below only catches the rare non-persistent parent.
  const { byArea, childrenByParent, orphanGroupsByArea } = useMemo(() => {
    const openIds = new Set(data.openItems.map((i) => i.id));
    const children: Record<string, OpenItem[]> = {};
    const orphans: Record<string, OpenItem[]> = {};
    const topLevel: OpenItem[] = [];
    for (const it of data.openItems) {
      const pid = it.raisedFromRootId;
      if (pid && openIds.has(pid)) {
        (children[pid] ??= []).push(it);
      } else if (pid && data.raisedParents[pid] && !data.raisedParents[pid].open) {
        (orphans[pid] ??= []).push(it);
      } else {
        topLevel.push(it);
      }
    }
    const area: Record<string, OpenItem[]> = {};
    for (const it of topLevel) (area[areaOverride[it.id] ?? it.area] ??= []).push(it);
    const orphanArea: Record<string, { parentId: string; info: { title: string; status: string }; children: OpenItem[] }[]> = {};
    for (const [pid, kids] of Object.entries(orphans)) {
      const a = kids[0].area;
      (orphanArea[a] ??= []).push({ parentId: pid, info: data.raisedParents[pid], children: kids });
    }
    return { byArea: area, childrenByParent: children, orphanGroupsByArea: orphanArea };
  }, [data.openItems, data.raisedParents, areaOverride]);

  // Tabbed review: only the active area's items are shown, like Browse.
  const [activeArea, setActiveArea] = useState<string>(() => data.areas[0] ?? "General");
  // Locally-added empty tabs (an area with no items yet). Filing a new minute
  // under one commits it for real; a name that matches an existing area just
  // reuses that tab rather than creating a duplicate.
  const [extraAreas, setExtraAreas] = useState<string[]>([]);
  const allAreas = useMemo(
    () => [...new Set([...data.areas, ...extraAreas])],
    [data.areas, extraAreas]
  );
  const currentArea = allAreas.includes(activeArea) ? activeArea : (allAreas[0] ?? "General");

  const [addingTab, setAddingTab] = useState(false);
  const [newTabName, setNewTabName] = useState("");
  function addTab() {
    const name = newTabName.trim();
    setNewTabName("");
    setAddingTab(false);
    if (!name) return;
    const existing = allAreas.find((a) => a.toLowerCase() === name.toLowerCase());
    if (existing) {
      setActiveArea(existing); // reuse the existing tab (and its items)
      return;
    }
    setExtraAreas((prev) => [...prev, name]);
    setActiveArea(name);
  }

  function setUpdate(id: string, patch: Partial<ItemUpdate>) {
    setUpdates((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }
  function addNewMinute(area: string) {
    setNewMinutes((prev) => [
      ...prev,
      {
        area, title: "", description: "", type: "Note", status: "New", assignedTo: "", dueDate: "",
        tags: [],
        devopsAction: "none", devopsProject: "", devopsWorkItemType: "User Story", devopsWorkItemId: ""
      }
    ]);
  }
  function setNewMinute(i: number, patch: Partial<NewMinute>) {
    setNewMinutes((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }
  function removeNewMinute(i: number) {
    setNewMinutes((prev) => prev.filter((_, idx) => idx !== i));
  }
  // Tasks hung off a brand-new minute — same idea as "items under this" on a
  // carried-forward item, but the parent doesn't exist in the DB yet, so they
  // travel with it and are written straight after it on save.
  function addNewMinuteChild(i: number) {
    setNewMinutes((prev) =>
      prev.map((m, idx) =>
        idx === i
          ? { ...m, children: [...(m.children ?? []), { ...emptySub(), area: m.area }] }
          : m
      )
    );
  }
  function setNewMinuteChild(i: number, ci: number, patch: Partial<NewMinute>) {
    setNewMinutes((prev) =>
      prev.map((m, idx) =>
        idx === i
          ? { ...m, children: (m.children ?? []).map((c, k) => (k === ci ? { ...c, ...patch } : c)) }
          : m
      )
    );
  }
  function removeNewMinuteChild(i: number, ci: number) {
    setNewMinutes((prev) =>
      prev.map((m, idx) =>
        idx === i ? { ...m, children: (m.children ?? []).filter((_, k) => k !== ci) } : m
      )
    );
  }

  // One new-minute editor card. Rendered inline under its area (so a freshly
  // added minute appears right where you clicked, not in a section off-screen).
  function renderNewMinuteEditor(m: NewMinute, i: number) {
    return (
      <div key={i} className="rounded border-l-4 border-l-brand-blue bg-blue-100 p-2">
        <div className="mb-1 flex items-center gap-2">
          <DragGrip
            onStart={() => setDragItem({ kind: "newMinute", index: i })}
            onEnd={endDrag}
            label="Drag onto an item to nest it, or onto a tab"
          />
          <input
            value={m.title}
            onChange={(e) => setNewMinute(i, { title: e.target.value })}
            placeholder="Title"
            autoFocus={!m.title}
            className="flex-1 rounded border border-slate-300 p-1 text-sm"
          />
          <button
            onClick={() => removeNewMinute(i)}
            className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
            title="Remove"
          >
            ✕
          </button>
        </div>
        <textarea
          value={m.description}
          onChange={(e) => setNewMinute(i, { description: e.target.value })}
          rows={5}
          placeholder="What was discussed…"
          className="w-full resize-y rounded border border-slate-300 p-2 text-sm"
        />
        <div className="mt-1">
          <TagChips value={m.tags} onChange={(tags) => setNewMinute(i, { tags })} />
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1 text-xs">
          <input
            value={m.area}
            onChange={(e) => setNewMinute(i, { area: e.target.value })}
            placeholder="Area"
            className="rounded border border-slate-300 p-1"
          />
          <select
            value={m.type}
            onChange={(e) =>
              setNewMinute(i, {
                type: e.target.value,
                ...(e.target.value !== "Devops" ? { devopsAction: "none" } : {})
              })
            }
            className="rounded border border-slate-300 p-1"
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        {/* Status/owner/due only apply to a To-Do or DevOps, not a plain Note. */}
        {m.type !== "Note" && (
          <div className="mt-1 grid grid-cols-1 gap-1 text-xs sm:grid-cols-3">
            <select
              value={m.status}
              onChange={(e) => setNewMinute(i, { status: e.target.value })}
              className="rounded border border-slate-300 p-1"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select
              value={m.assignedTo}
              onChange={(e) => setNewMinute(i, { assignedTo: e.target.value })}
              className="rounded border border-slate-300 p-1"
            >
              <option value="">— Unassigned —</option>
              {/* Keep the AI's suggestion selectable even if not in the roster */}
              {m.assignedTo && !members.some((mem) => mem.displayName === m.assignedTo) && (
                <option value={m.assignedTo}>{m.assignedTo} (AI)</option>
              )}
              {members.map((mem) => (
                <option key={mem.id} value={mem.displayName}>{mem.displayName}</option>
              ))}
            </select>
            <input
              type="date"
              value={m.dueDate}
              onChange={(e) => setNewMinute(i, { dueDate: e.target.value })}
              className="rounded border border-slate-300 p-1"
            />
          </div>
        )}
        {m.type === "Devops" && (
          <DevopsControls
            action={m.devopsAction}
            project={m.devopsProject}
            workItemType={m.devopsWorkItemType}
            workItemId={m.devopsWorkItemId}
            devopsEnabled={devopsEnabled}
            devopsProjects={devopsProjects}
            onChange={(patch) => setNewMinute(i, patch)}
          />
        )}

        {/* Tasks under this new minute — saved nested beneath it. */}
        {(m.children ?? []).length > 0 && (
          <div className="mt-2 space-y-2 border-t border-blue-200 pt-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Items under this
            </div>
            {(m.children ?? []).map((c, ci) => (
              <div key={ci} className="rounded border-l-4 border-l-slate-300 bg-white p-2">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <select
                    value={c.type}
                    onChange={(e) => setNewMinuteChild(i, ci, { type: e.target.value })}
                    className="rounded border border-slate-300 p-1 text-[11px]"
                  >
                    {SUB_TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <input
                    value={c.title}
                    onChange={(e) => setNewMinuteChild(i, ci, { title: e.target.value })}
                    placeholder="Title"
                    className="flex-1 rounded border border-slate-300 p-1 text-sm"
                  />
                  <button
                    onClick={() => removeNewMinuteChild(i, ci)}
                    className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
                <textarea
                  value={c.description}
                  onChange={(e) => setNewMinuteChild(i, ci, { description: e.target.value })}
                  rows={2}
                  placeholder="Description"
                  className="w-full rounded border border-slate-300 p-1 text-sm"
                />
                <div className="mt-1 grid grid-cols-1 gap-1 text-xs sm:grid-cols-3">
                  <select
                    value={c.status}
                    onChange={(e) => setNewMinuteChild(i, ci, { status: e.target.value })}
                    className="rounded border border-slate-300 p-1"
                  >
                    {STATUS_OPTIONS.map((st) => (
                      <option key={st} value={st}>{st}</option>
                    ))}
                  </select>
                  <select
                    value={c.assignedTo}
                    onChange={(e) => setNewMinuteChild(i, ci, { assignedTo: e.target.value })}
                    className="rounded border border-slate-300 p-1"
                  >
                    <option value="">— Unassigned —</option>
                    {assigneeOptions(c.assignedTo).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  <input
                    type="date"
                    value={c.dueDate}
                    onChange={(e) => setNewMinuteChild(i, ci, { dueDate: e.target.value })}
                    className="rounded border border-slate-300 p-1"
                  />
                </div>
                {c.type === "Devops" && (
                  <DevopsControls
                    action={c.devopsAction}
                    project={c.devopsProject}
                    workItemType={c.devopsWorkItemType}
                    workItemId={c.devopsWorkItemId}
                    devopsEnabled={devopsEnabled}
                    devopsProjects={devopsProjects}
                    onChange={(patch) => setNewMinuteChild(i, ci, patch)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
        <button
          onClick={() => addNewMinuteChild(i)}
          className="mt-2 rounded border border-dashed border-slate-400 px-2 py-1 text-xs text-slate-600 hover:bg-white"
        >
          + Add to-do / devops under this item
        </button>
      </div>
    );
  }

  async function aiPreFill() {
    if (!recorder.transcript.trim()) return;
    setAnalyzing(true);
    setAnalysisProgress(null);
    setError("");
    try {
      // Long transcripts are analysed in chunks (one call at a time) so no single
      // request hits Vercel's 60s cap.
      const plan = await analyzeFollowupChunked(recorder.transcript, data.parent.id, (p) =>
        setAnalysisProgress({ done: p.done, total: p.total })
      );
      applyPlan(plan);
      if (plan.summary?.trim()) setAiSummary(plan.summary.trim());
    } catch (e) {
      setError("AI pre-fill failed: " + (e instanceof Error ? e.message : "unknown"));
    } finally {
      setAnalyzing(false);
      setAnalysisProgress(null);
    }
  }

  // Maps the AI's per-item updates onto the worklist and appends new minutes.
  // Only touches items the AI marked as discussed; the human still reviews all.
  function applyPlan(plan: {
    updates?: { rootMinuteId: string; discussed: boolean; note: string; status: string; tags?: string[]; devopsAction: string; devopsWorkItemType: string; devopsWorkItemId: string }[];
    newMinutes?: { area: string; title: string; description: string; minuteType: string; status: string; assignedTo: string; tags?: string[]; devopsAction: string; devopsWorkItemType: string; devopsWorkItemId: string; raisedUnderRootId?: string | null }[];
  }) {
    const filled = new Set<string>();
    setUpdates((prev) => {
      const next = { ...prev };
      for (const u of plan.updates ?? []) {
        if (!next[u.rootMinuteId] || !u.discussed) continue;
        const wantsDevops = u.devopsAction === "create" || u.devopsAction === "link";
        next[u.rootMinuteId] = {
          ...next[u.rootMinuteId],
          noUpdate: false,
          note: u.note || next[u.rootMinuteId].note,
          status: STATUS_OPTIONS.includes(u.status) ? u.status : next[u.rootMinuteId].status,
          // Union: an AI suggestion adds a flag, it never drops one carried forward.
          tags: normalizeTags([...next[u.rootMinuteId].tags, ...(u.tags ?? [])]),
          // A DevOps suggestion arms the controls (type -> Devops) for review.
          ...(wantsDevops
            ? {
                type: "Devops",
                devopsAction: u.devopsAction,
                devopsWorkItemType: u.devopsWorkItemType === "Bug" ? "Bug" : "User Story",
                devopsWorkItemId: u.devopsWorkItemId || ""
              }
            : {})
        };
        filled.add(u.rootMinuteId);
      }
      return next;
    });
    setAiFilled(filled);

    // New items split two ways: those the AI raised UNDER an existing open item
    // nest as that item's sub-entries (same path as the manual "+ Add under this
    // item"); the rest are standalone new minutes, exactly as before.
    const openIds = new Set(data.openItems.map((it) => it.id));
    const flat: NewMinute[] = [];
    const nestedByParent = new Map<string, NewMinute[]>();
    for (const m of plan.newMinutes ?? []) {
      const wantsDevops = m.devopsAction === "create" || m.devopsAction === "link";
      const nm: NewMinute = {
        area: m.area || data.areas[0] || "General",
        title: m.title || "",
        description: m.description || "",
        type: wantsDevops ? "Devops" : TYPE_OPTIONS.includes(m.minuteType) ? m.minuteType : "Note",
        status: STATUS_OPTIONS.includes(m.status) ? m.status : "New",
        assignedTo: m.assignedTo || "",
        dueDate: "",
        tags: normalizeTags(m.tags),
        devopsAction: wantsDevops ? m.devopsAction : "none",
        devopsProject: "",
        devopsWorkItemType: m.devopsWorkItemType === "Bug" ? "Bug" : "User Story",
        devopsWorkItemId: m.devopsWorkItemId || ""
      };
      const parentId = m.raisedUnderRootId;
      // Nest only a to-do/devops under a real open item; anything else is flat.
      if (parentId && openIds.has(parentId) && (nm.type === "To-Do" || nm.type === "Devops")) {
        const arr = nestedByParent.get(parentId) ?? [];
        arr.push(nm);
        nestedByParent.set(parentId, arr);
      } else {
        flat.push(nm);
      }
    }
    if (flat.length) setNewMinutes((prev) => [...prev, ...flat]);
    if (nestedByParent.size) {
      setUpdates((prev) => {
        const next = { ...prev };
        for (const [pid, subs] of nestedByParent) {
          if (!next[pid]) continue;
          next[pid] = { ...next[pid], subEntries: [...next[pid].subEntries, ...subs] };
        }
        return next;
      });
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/followup/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentMeetingId: data.parent.id,
          meetingTitle: title,
          meetingDate: dateTimeLocalToISO(date),
          summary: aiSummary,
          transcript: recorder.transcript,
          updates: data.openItems.map((it) => ({ rootMinuteId: it.id, ...updates[it.id] })),
          newMinutes: newMinutes.filter((m) => m.title.trim())
        })
      });
      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
      recorder.clearTranscript(); // saved — the draft is done with
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  // Members assignable, keeping any AI/legacy name already on an item selectable.
  function assigneeOptions(current: string) {
    const names = members.map((m) => m.displayName);
    const extra = current && !names.includes(current) ? [current] : [];
    return [...extra, ...names];
  }

  // One nested sub-item's editable review block — used both under an open parent
  // ("Items under this") and under a completed parent's read-only header.
  function renderChildReview(child: OpenItem) {
    const cu = updates[child.id];
    if (!cu) return null;
    // A carried-forward sub-item (raised in an earlier meeting) is itself a
    // follow-up item, so it's yellow like the top-level items — a lighter amber
    // so it still reads as nested. Only items raised THIS meeting stay blue.
    return (
      <div key={child.id} className="rounded border-l-4 border-l-amber-500 bg-amber-50 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{child.title}</span>
          <span className="text-xs font-normal text-slate-500" title="When this item was first captured">
            🕒 {fmtDate(child.capturedAt)}
          </span>
          <select
            value={cu.type}
            onChange={(e) => setUpdate(child.id, { type: e.target.value })}
            className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]"
            title="Type"
          >
            {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select
            value={cu.status}
            onChange={(e) => setUpdate(child.id, { status: e.target.value })}
            disabled={cu.noUpdate}
            className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] disabled:opacity-50"
            title="Status"
          >
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={cu.assignedTo}
            onChange={(e) => setUpdate(child.id, { assignedTo: e.target.value })}
            className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]"
            title="Assignee"
          >
            <option value="">— Unassigned —</option>
            {assigneeOptions(cu.assignedTo).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <input
            type="date"
            value={cu.dueDate}
            onChange={(e) => setUpdate(child.id, { dueDate: e.target.value })}
            className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]"
            title="Due date"
          />
        </div>
        {child.description && (
          <div className="mt-0.5 text-xs text-slate-500">{child.description}</div>
        )}
        <label className="mt-1 flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={cu.noUpdate}
            onChange={(e) => setUpdate(child.id, { noUpdate: e.target.checked })}
          />
          No action
        </label>
        {!cu.noUpdate && (
          <textarea
            value={cu.note}
            onChange={(e) => setUpdate(child.id, { note: e.target.value })}
            rows={1}
            placeholder="What happened with this item?"
            className="mt-1 w-full rounded border border-slate-300 p-1 text-sm"
          />
        )}
      </div>
    );
  }

  if (result) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-lg font-bold text-white">✓</div>
        <div className="flex-1">
          <div className="font-semibold">
            Follow-up saved — {result.updated} update(s), {result.created} new item(s)
          </div>
          {result.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-amber-700">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {result.meetingId && (
            <a
              href={`/report/${result.meetingId}`}
              className="rounded bg-gradient-to-r from-brand-blue to-brand-purple px-4 py-2 text-center font-medium text-white"
              title="Open a printable report — use Download / Print PDF there"
            >
              📄 Report / PDF
            </a>
          )}
          <a
            href={result.meetingId ? `/browse?meeting=${result.meetingId}` : "/browse"}
            className="rounded border border-slate-300 px-4 py-2 text-center font-medium text-slate-700"
          >
            View in Browse
          </a>
        </div>
      </div>
    );
  }

  const totalOpen = data.openItems.length;

  return (
    <div className="space-y-4">
      {saving && (
        <BusyOverlay
          message="Please wait"
          detail="Saving and committing your follow-up meeting..."
        />
      )}

      {/* Block the whole form while the AI pre-fill runs, so nobody edits an item
          that's about to be overwritten by the analysis. */}
      {analyzing && (
        <BusyOverlay
          message={
            analysisProgress && analysisProgress.total > 1
              ? `Analyzing… part ${Math.min(analysisProgress.done + 1, analysisProgress.total)} of ${analysisProgress.total}`
              : "Analyzing transcript…"
          }
          detail="Reading the transcript and pre-filling the items below…"
        />
      )}

      {/* Header */}
      <div>
        <span className="mb-2 inline-block rounded bg-gradient-to-r from-amber-500 to-brand-purple px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-white">
          Follow-up
        </span>
        <h1 className="text-2xl font-bold">Follow-up Meeting</h1>
        <p className="text-sm text-slate-600">
          Following up on <span className="font-medium">{parentDisplayTitle}</span> · {data.parent.projectName} ·{" "}
          {fmtDate(data.parent.date)}
        </p>
        {data.parent.attachments.length > 0 && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
            <MeetingAttachments
              meetingId={data.parent.id}
              attachments={data.parent.attachments}
              canEdit={false}
            />
          </div>
        )}
      </div>

      {/* Optional: record the meeting and let AI pre-fill each item's update */}
      <div className="rounded-lg border-2 border-dashed border-brand-purple/40 bg-white p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-brand-purple">Optional — record &amp; AI pre-fill</span>
          {!recorder.isRecording ? (
            <button
              onClick={recorder.startRecording}
              disabled={recorder.isTranscribing || analyzing}
              className="rounded bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Start Recording
            </button>
          ) : (
            <button onClick={recorder.stopRecording} className="rounded bg-red-500 px-3 py-1.5 text-sm font-medium text-white">
              Stop
            </button>
          )}
          <button
            onClick={aiPreFill}
            disabled={!recorder.transcript.trim() || recorder.isRecording || recorder.isTranscribing || analyzing}
            className="rounded bg-brand-purple px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {analyzing
              ? analysisProgress && analysisProgress.total > 1
                ? `Analyzing… ${Math.min(analysisProgress.done + 1, analysisProgress.total)}/${analysisProgress.total}`
                : "Analyzing…"
              : "AI pre-fill ↓"}
          </button>
          <button
            onClick={() =>
              downloadTranscript({
                title,
                date: dateTimeLocalToISO(date),
                projectName: data.parent.projectName,
                transcript: recorder.transcript
              })
            }
            disabled={!recorder.transcript.trim()}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600 disabled:opacity-40"
            title="Save the transcript as a readable text file (who said what)"
          >
            ⬇ Transcript
          </button>
          <button
            onClick={recorder.clearTranscript}
            disabled={!recorder.transcript.trim() || recorder.isRecording || recorder.isTranscribing || analyzing}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600 disabled:opacity-40"
            title="Clear the transcript"
          >
            Clear
          </button>
          <label className="ml-2 flex items-center gap-1 text-sm">
            <input type="checkbox" checked={recorder.captureMic} onChange={(e) => recorder.setCaptureMic(e.target.checked)} disabled={recorder.isRecording} /> Mic
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={recorder.captureTab} onChange={(e) => recorder.setCaptureTab(e.target.checked)} disabled={recorder.isRecording} /> Tab audio
          </label>
          {recorder.isRecording && (
            <span className="flex items-center gap-1.5 text-sm text-red-600">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              Recording
              {recorder.segDone < recorder.segTotal && (
                <span className="text-blue-600">· transcribing {recorder.segDone}/{recorder.segTotal}</span>
              )}
            </span>
          )}
          {!recorder.isRecording && recorder.isTranscribing && (
            <span className="text-sm text-blue-600">Transcribing {recorder.segDone}/{recorder.segTotal}…</span>
          )}
        </div>
        <p className="mb-2 text-xs text-slate-500">
          Online meeting? Pick <b>“Entire Screen”</b> and turn on <b>“Also share system audio”</b> to capture other
          participants. In a browser tab? Use <b>“Chrome Tab”</b>. In-person? Untick <b>Tab audio</b> (mic only).
        </p>
        <textarea
          value={recorder.transcript}
          onChange={(e) => recorder.setTranscript(e.target.value)}
          readOnly={recorder.isRecording || recorder.isTranscribing}
          placeholder="Record the meeting (or paste a transcript), then AI pre-fill fills each item's update below. You still review everything."
          className="h-32 w-full resize-y rounded border border-slate-300 p-2 text-sm"
        />
        {recorder.error && <div className="mt-1 text-xs text-red-600">{recorder.error}</div>}
      </div>

      {/* Meeting title + date */}
      <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-xs font-semibold uppercase text-slate-500">Meeting title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="text-xs font-semibold uppercase text-slate-500">Date &amp; time</span>
          <input
            type="datetime-local"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
          />
        </label>
      </div>

      {/* Gap-check opens in its OWN tab so this page — and the recording — is
          never navigated away from. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-dashed border-amber-300 bg-amber-50/50 p-4">
        <button
          onClick={() => {
            writeGapsPayload({
              source: "followup",
              meetingTitle: title,
              transcript: recorder.transcript,
              captured: [
                ...data.openItems.map((it) => ({
                  title: it.title,
                  description: updates[it.id]?.note || it.description || "",
                  type: it.type
                })),
                ...newMinutes.map((m) => ({
                  title: m.title,
                  description: m.description,
                  type: m.type
                }))
              ],
              areas: allAreas
            });
            window.open("/gaps", "_blank", "noopener");
          }}
          disabled={!recorder.transcript.trim() || recorder.isRecording || recorder.isTranscribing || analyzing}
          className="rounded bg-amber-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          ✨ AI Recommendation ↗
        </button>
        <span className="text-xs text-slate-500">
          {!recorder.transcript.trim()
            ? "Needs a transcript — record the meeting (each ~10-minute segment appears as it finishes) or paste one above."
            : "Opens a new tab where AI compares what you've written — including the notes on open items — with the transcript."}
        </span>
      </div>

      {/* Carried-forward open items */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-lg font-semibold">
          Open items to review ({totalOpen})
        </h2>
        <p className="mb-3 text-xs text-slate-500">
          Go through each item and record what happened. Set status to <em>Closed</em> to close it
          (or <em>Resolved</em> to mark it done but keep tracking it in follow-ups). Leave one as
          “No update” to carry it forward unchanged.
        </p>

        {totalOpen === 0 ? (
          <p className="rounded border border-dashed border-slate-300 p-4 text-sm text-slate-500">
            No open items to carry forward from this project. You can still add new minutes below.
          </p>
        ) : (
          <>
          {/* Area tabs — sticky so they stay reachable as a drop target while
              you scroll a long list (like Browse). */}
          <div className="sticky top-0 z-20 -mx-4 mb-4 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white/95 px-4 pb-2 pt-2 backdrop-blur">
            {allAreas.map((area) => {
              const count =
                (byArea[area] ?? []).length +
                (orphanGroupsByArea[area] ?? []).reduce((n, g) => n + g.children.length, 0);
              const active = area === currentArea;
              return (
                <button
                  key={area}
                  onClick={() => setActiveArea(area)}
                  onDragOver={(e) => {
                    if (dragItem) {
                      e.preventDefault();
                      setDragOverArea(area);
                    }
                  }}
                  onDragLeave={() => setDragOverArea((a) => (a === area ? null : a))}
                  onDrop={(e) => {
                    e.preventDefault();
                    onDropOnTab(area);
                  }}
                  className={`rounded-t px-3 py-1.5 text-sm font-medium ${
                    active
                      ? "bg-brand-blue/10 text-brand-blue"
                      : "text-slate-500 hover:bg-slate-100"
                  } ${dragOverArea === area ? "ring-2 ring-brand-blue ring-inset" : ""}`}
                >
                  {area}
                  {count > 0 && <span className="ml-1 text-xs text-slate-400">({count})</span>}
                </button>
              );
            })}
            {addingTab ? (
              <input
                autoFocus
                value={newTabName}
                onChange={(e) => setNewTabName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTab();
                  if (e.key === "Escape") {
                    setAddingTab(false);
                    setNewTabName("");
                  }
                }}
                onBlur={addTab}
                placeholder="Tab name…"
                className="w-32 rounded border border-brand-blue px-2 py-1 text-sm"
              />
            ) : (
              <button
                onClick={() => setAddingTab(true)}
                className="rounded px-2 py-1.5 text-sm font-medium text-brand-blue hover:bg-blue-50"
                title="Add a tab — reuses an existing area if the name matches"
              >
                + Add tab
              </button>
            )}
          </div>
          <p className="mb-3 text-xs text-slate-400">
            Tip: drag an item&apos;s <span className="text-slate-500">⠿</span> grip onto a tab to re-file it, or
            onto another item to nest it underneath.
          </p>
          {allAreas.map((area) =>
            area !== currentArea ? null : (
            <div key={area} className="mb-4">
              <div className="space-y-5">
                {(byArea[area] ?? []).map((it) => {
                  const u = updates[it.id];
                  return (
                    <div
                      key={it.id}
                      onDragOver={(e) => {
                        // Accept only draggables that can nest here.
                        if (dragItem && dragItem.kind !== "openItem") {
                          e.preventDefault();
                          setDragOverItem(it.id);
                        }
                      }}
                      onDragLeave={() => setDragOverItem((x) => (x === it.id ? null : x))}
                      onDrop={(e) => {
                        e.preventDefault();
                        onDropOnItem(it.id);
                      }}
                      className={`rounded-lg border-l-4 border-l-amber-500 bg-amber-100 p-3 ${
                        dragOverItem === it.id ? "ring-2 ring-brand-blue" : ""
                      }`}
                    >
                      {/* Original item summary — the item's own fields (type,
                          status, owner, due) are editable right here. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <DragGrip onStart={() => setDragItem({ kind: "openItem", id: it.id })} onEnd={endDrag} label="Drag to another tab" />
                        <span className="font-semibold">{it.title}</span>
                        <span className="text-xs font-normal text-slate-500" title="When this item was first captured">
                          🕒 {fmtDate(it.capturedAt)}
                        </span>
                        {aiFilled.has(it.id) && (
                          <span className="rounded bg-brand-purple px-1.5 py-0.5 text-[10px] font-medium text-white">AI</span>
                        )}
                        <select
                          value={u.type}
                          onChange={(e) => setUpdate(it.id, { type: e.target.value })}
                          className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]"
                          title="Type"
                        >
                          {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                        <select
                          value={u.status}
                          onChange={(e) => setUpdate(it.id, { status: e.target.value })}
                          disabled={u.noUpdate}
                          className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] disabled:opacity-50"
                          title={u.noUpdate ? "No status change while 'No action' is ticked" : "Status"}
                        >
                          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <select
                          value={u.assignedTo}
                          onChange={(e) => setUpdate(it.id, { assignedTo: e.target.value })}
                          className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]"
                          title="Assignee"
                        >
                          <option value="">— Unassigned —</option>
                          {assigneeOptions(u.assignedTo).map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <input
                          type="date"
                          value={u.dueDate}
                          onChange={(e) => setUpdate(it.id, { dueDate: e.target.value })}
                          className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]"
                          title="Due date"
                        />
                        {it.devopsItemId &&
                          (devopsBaseUrl ? (
                            <a
                              href={`${devopsBaseUrl}/_workitems/edit/${it.devopsItemId}`}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 hover:bg-orange-200"
                            >
                              🔗 DevOps #{it.devopsItemId}
                            </a>
                          ) : (
                            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">
                              🔗 DevOps #{it.devopsItemId}
                            </span>
                          ))}
                      </div>
                      {it.description && <div className="mt-1 text-sm text-slate-600">{it.description}</div>}

                      {/* Governance flags — set on the ITEM, so they carry across
                          every meeting the item appears in. */}
                      <div className="mt-1">
                        <TagChips value={u.tags} onChange={(tags) => setUpdate(it.id, { tags })} />
                      </div>

                      {/* Prior updates */}
                      {it.history.length > 0 && (
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer text-slate-500">
                            {it.history.length} prior update(s)
                          </summary>
                          <ul className="mt-1 space-y-1 border-l-2 border-slate-200 pl-3">
                            {it.history.map((h, i) => (
                              <li key={i} className="text-slate-600">
                                <span className="text-slate-400">{fmtDate(h.date)}</span>
                                {h.description ? <> — {h.description}</> : null}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}

                      {/* Update controls — the item's own update is just a note.
                          Its state (type/status/owner/due) is edited on the header
                          above; set Status → Closed there to close it. */}
                      <div className="mt-2 rounded border border-amber-200 bg-white p-2">
                        <label className="flex items-center gap-1 text-xs text-slate-600">
                          <input
                            type="checkbox"
                            checked={u.noUpdate}
                            onChange={(e) => setUpdate(it.id, { noUpdate: e.target.checked })}
                          />
                          No action this meeting
                        </label>

                        {!u.noUpdate && (
                          <textarea
                            value={u.note}
                            onChange={(e) => setUpdate(it.id, { note: e.target.value })}
                            rows={2}
                            placeholder="What happened with this item?"
                            className="mt-2 w-full rounded border border-slate-300 p-2 text-sm"
                          />
                        )}

                        {/* Items raised under this in EARLIER meetings — nested so
                            they stay with the parent, each still updatable on its
                            own (marking one complete closes just that item). */}
                        {(childrenByParent[it.id] ?? []).length > 0 && (
                          <div className="mt-3 space-y-2 border-t border-amber-200 pt-2">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                              Items under this
                            </div>
                            {(childrenByParent[it.id] ?? []).map((child) => renderChildReview(child))}
                          </div>
                        )}

                        {/* New minutes raised under this item THIS meeting. */}
                        {u.subEntries.length > 0 && (
                          <div className="mt-3 space-y-2 border-t border-amber-200 pt-2">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                              Raised under this item
                            </div>
                            {u.subEntries.map((s, si) => (
                              <div key={si} className="rounded border-l-4 border-l-brand-blue bg-blue-100 p-2">
                                <div className="mb-1 flex items-center gap-2">
                                  <DragGrip
                                    onStart={() => setDragItem({ kind: "subEntry", parentId: it.id, index: si })}
                                    onEnd={endDrag}
                                    label="Drag under another item, or onto a tab to un-nest"
                                  />
                                  <select
                                    value={s.type}
                                    onChange={(e) =>
                                      setSub(it.id, si, {
                                        type: e.target.value,
                                        ...(e.target.value !== "Devops" ? { devopsAction: "none" } : {})
                                      })
                                    }
                                    className="rounded border border-slate-300 p-1 text-xs"
                                  >
                                    {SUB_TYPE_OPTIONS.map((t) => (
                                      <option key={t} value={t}>{t}</option>
                                    ))}
                                  </select>
                                  <input
                                    value={s.title}
                                    onChange={(e) => setSub(it.id, si, { title: e.target.value })}
                                    placeholder="Title"
                                    className="flex-1 rounded border border-slate-300 p-1 text-sm"
                                  />
                                  <button
                                    onClick={() => removeSub(it.id, si)}
                                    className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-100"
                                    title="Remove"
                                  >
                                    ✕
                                  </button>
                                </div>
                                <textarea
                                  value={s.description}
                                  onChange={(e) => setSub(it.id, si, { description: e.target.value })}
                                  rows={1}
                                  placeholder="Description"
                                  className="w-full rounded border border-slate-300 p-1 text-sm"
                                />
                                {/* A Note is just title + description; status/owner
                                    /due only make sense for a To-Do or DevOps. */}
                                {s.type !== "Note" && (
                                  <div className="mt-1 grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
                                    <select
                                      value={s.status}
                                      onChange={(e) => setSub(it.id, si, { status: e.target.value })}
                                      className="rounded border border-slate-300 p-1"
                                    >
                                      {STATUS_OPTIONS.map((st) => (
                                        <option key={st} value={st}>{st}</option>
                                      ))}
                                    </select>
                                    <select
                                      value={s.assignedTo}
                                      onChange={(e) => setSub(it.id, si, { assignedTo: e.target.value })}
                                      className="rounded border border-slate-300 p-1"
                                    >
                                      <option value="">— Unassigned —</option>
                                      {assigneeOptions(s.assignedTo).map((n) => (
                                        <option key={n} value={n}>{n}</option>
                                      ))}
                                    </select>
                                    <input
                                      type="date"
                                      value={s.dueDate}
                                      onChange={(e) => setSub(it.id, si, { dueDate: e.target.value })}
                                      className="rounded border border-slate-300 p-1"
                                    />
                                  </div>
                                )}
                                {s.type === "Devops" && (
                                  <DevopsControls
                                    action={s.devopsAction}
                                    project={s.devopsProject}
                                    workItemType={s.devopsWorkItemType}
                                    workItemId={s.devopsWorkItemId}
                                    devopsEnabled={devopsEnabled}
                                    devopsProjects={devopsProjects}
                                    onChange={(patch) => setSub(it.id, si, patch)}
                                  />
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        <button
                          onClick={() => addSub(it.id)}
                          className="mt-2 rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                        >
                          + Add to-do / devops under this item
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Open items whose parent is already CLOSED: the parent no longer
                  carries forward, but its open to-do/devops still needs review —
                  so render each as a normal editable (yellow) follow-up item with
                  a small caption linking it to its closed parent. */}
              {(orphanGroupsByArea[area] ?? []).flatMap((grp) =>
                grp.children.map((child) => (
                  <div key={child.id} className="mt-5">
                    <div className="mb-1 text-[11px] text-slate-400">
                      ↳ under{" "}
                      <span className="font-medium text-slate-500">{grp.info.title}</span>
                      <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-slate-500">
                        {grp.info.status}
                      </span>
                      <span className="ml-1 italic">— shown for context</span>
                    </div>
                    {renderChildReview(child)}
                  </div>
                ))
              )}

              <button
                onClick={() => addNewMinute(area)}
                className="mt-2 rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                + Add new minute in {area}
              </button>
              {/* New minutes for this area appear right here, where you clicked. */}
              {newMinutes.some((m) => m.area === area) && (
                <div className="mt-2 space-y-2">
                  {newMinutes.map((m, i) => (m.area === area ? renderNewMinuteEditor(m, i) : null))}
                </div>
              )}
            </div>
          ))}
          </>
        )}
      </div>

      {/* New minutes in a brand-new area (anything not one of the tabs above).
          Minutes added to an existing area render inline under that area. */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New minute in a new area</h2>
          <button
            onClick={() => addNewMinute("")}
            className="rounded bg-brand-blue px-3 py-1 text-sm font-medium text-white"
          >
            + Add minute
          </button>
        </div>

        {newMinutes.some((m) => !allAreas.includes(m.area)) ? (
          <div className="space-y-2">
            {newMinutes.map((m, i) => (!allAreas.includes(m.area) ? renderNewMinuteEditor(m, i) : null))}
          </div>
        ) : (
          <p className="text-sm text-slate-400">
            Use this only for a topic that isn&apos;t one of the tabs above — type its area name in the minute.
            To add to an existing area, use its <b>+ Add new minute</b> button.
          </p>
        )}
      </div>

      {error && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* Actions */}
      <div className="flex items-center gap-2">
        <a href="/browse" className="rounded border border-slate-300 px-4 py-2 text-sm">Cancel</a>
        <button
          onClick={save}
          disabled={saving || !title.trim()}
          className="ml-auto rounded bg-gradient-to-r from-brand-pink to-brand-purple px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "✓ Save follow-up meeting"}
        </button>
      </div>
    </div>
  );
}

// DevOps Create/Link controls, shared by item updates and new minutes. Shown
// when the entry's type is Devops. Creation runs on Save (never before).
function DevopsControls({
  action,
  project,
  workItemType,
  workItemId,
  devopsEnabled,
  devopsProjects,
  onChange
}: {
  action: string;
  project: string;
  workItemType: string;
  workItemId: string;
  devopsEnabled: boolean;
  devopsProjects: { id: string; name: string }[];
  onChange: (patch: DevopsPatch) => void;
}) {
  return (
    <div className="mt-2 rounded border border-orange-200 bg-orange-50 p-2">
      <div className="mb-1 flex flex-wrap items-center gap-3 text-xs">
        <span className="font-semibold text-orange-700">DevOps</span>
        {(["none", "create", "link"] as const).map((act) => (
          <label key={act} className="flex items-center gap-1">
            <input type="radio" checked={action === act} onChange={() => onChange({ devopsAction: act })} />
            {act === "none" ? "No work item" : act === "create" ? "Create" : "Link existing"}
          </label>
        ))}
        {!devopsEnabled && action !== "none" && (
          <span className="text-orange-600">⚠ DevOps not connected yet — will be skipped</span>
        )}
      </div>

      {action === "create" && (
        <div className="grid grid-cols-2 gap-1 text-xs">
          {devopsProjects.length > 0 ? (
            <select
              value={project}
              onChange={(e) => onChange({ devopsProject: e.target.value })}
              className="rounded border border-slate-300 p-1"
            >
              <option value="">— Select project —</option>
              {project && !devopsProjects.some((p) => p.name === project) && (
                <option value={project}>{project} (AI)</option>
              )}
              {devopsProjects.map((p) => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
            </select>
          ) : (
            <input
              value={project}
              onChange={(e) => onChange({ devopsProject: e.target.value })}
              className="rounded border border-slate-300 p-1"
              placeholder="DevOps project (e.g. 3TT.OneMinute)"
            />
          )}
          <select
            value={workItemType}
            onChange={(e) => onChange({ devopsWorkItemType: e.target.value })}
            className="rounded border border-slate-300 p-1"
          >
            <option value="User Story">User Story</option>
            <option value="Bug">Bug</option>
          </select>
        </div>
      )}

      {action === "link" && (
        <input
          value={workItemId}
          onChange={(e) => onChange({ devopsWorkItemId: e.target.value })}
          className="w-40 rounded border border-slate-300 p-1 text-xs"
          placeholder="Work Item ID"
        />
      )}
    </div>
  );
}
