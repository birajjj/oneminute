"use client";

import { useEffect, useMemo, useState } from "react";
import type { FollowUpData, OpenItem } from "@/lib/followup";
import { useSegmentRecorder } from "@/lib/useSegmentRecorder";
import { TagChips } from "@/components/TagChips";
import { normalizeTags } from "@/lib/tags";

const TYPE_OPTIONS = ["Note", "To-Do", "Action", "Devops"];
// Types allowed for extra minutes raised under an open item (boss: note/todo/
// devops, not action).
const SUB_TYPE_OPTIONS = ["Note", "To-Do", "Devops"];
const STATUS_OPTIONS = ["New", "Initiated", "In Progress", "Completed", "Cancelled"];

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

function todayDateInput(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  const initialDate = todayDateInput();
  const parentDisplayTitle = stripFollowUpSuffixes(data.parent.title) || data.parent.title;
  const [title, setTitle] = useState(() => buildFollowUpTitle(data.parent.title, initialDate));
  const [date, setDate] = useState(initialDate);

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

  // Sub-entries: add / edit / remove a note-todo-devops under a given open item.
  function emptySub(): NewMinute {
    return {
      area: "", title: "", description: "", type: "Note", status: "New",
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ updated: number; created: number; warnings: string[] } | null>(null);

  // Optional AI pre-fill: record → transcribe → map to the open items below.
  const recorder = useSegmentRecorder(`oneminute:followup:${data.parent.id}`);
  const [analyzing, setAnalyzing] = useState(false);
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

  // Items raised under another open item are nested beneath that parent (so they
  // travel with the original minute) instead of appearing as their own row. An
  // orphan (its parent already closed) falls back to being top-level.
  const { byArea, childrenByParent } = useMemo(() => {
    const openIds = new Set(data.openItems.map((i) => i.id));
    const children: Record<string, OpenItem[]> = {};
    const topLevel: OpenItem[] = [];
    for (const it of data.openItems) {
      if (it.raisedFromRootId && openIds.has(it.raisedFromRootId)) {
        (children[it.raisedFromRootId] ??= []).push(it);
      } else {
        topLevel.push(it);
      }
    }
    const area: Record<string, OpenItem[]> = {};
    for (const it of topLevel) (area[it.area] ??= []).push(it);
    return { byArea: area, childrenByParent: children };
  }, [data.openItems]);

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

  // One new-minute editor card. Rendered inline under its area (so a freshly
  // added minute appears right where you clicked, not in a section off-screen).
  function renderNewMinuteEditor(m: NewMinute, i: number) {
    return (
      <div key={i} className="rounded border-l-4 border-l-brand-blue bg-blue-50 p-2">
        <div className="mb-1 flex items-center gap-2">
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
          rows={2}
          placeholder="Description"
          className="w-full rounded border border-slate-300 p-1 text-sm"
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
      </div>
    );
  }

  async function aiPreFill() {
    if (!recorder.transcript.trim()) return;
    setAnalyzing(true);
    setError("");
    try {
      const res = await fetch("/api/followup/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentMeetingId: data.parent.id, transcript: recorder.transcript })
      });
      if (!res.ok) throw new Error(await res.text());
      applyPlan(await res.json());
    } catch (e) {
      setError("AI pre-fill failed: " + (e instanceof Error ? e.message : "unknown"));
    } finally {
      setAnalyzing(false);
    }
  }

  // Maps the AI's per-item updates onto the worklist and appends new minutes.
  // Only touches items the AI marked as discussed; the human still reviews all.
  function applyPlan(plan: {
    updates?: { rootMinuteId: string; discussed: boolean; note: string; status: string; tags?: string[]; devopsAction: string; devopsWorkItemType: string; devopsWorkItemId: string }[];
    newMinutes?: { area: string; title: string; description: string; minuteType: string; status: string; assignedTo: string; tags?: string[]; devopsAction: string; devopsWorkItemType: string; devopsWorkItemId: string }[];
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

    const mapped: NewMinute[] = (plan.newMinutes ?? []).map((m) => {
      const wantsDevops = m.devopsAction === "create" || m.devopsAction === "link";
      return {
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
    });
    if (mapped.length) setNewMinutes((prev) => [...prev, ...mapped]);
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
          meetingDate: date,
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

  if (result) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-lg font-bold text-white">✓</div>
        <div className="flex-1">
          <div className="font-semibold">
            Follow-up saved — {result.updated} update(s), {result.created} new minute(s)
          </div>
          {result.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-amber-700">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
        <a href="/browse" className="rounded bg-brand-blue px-4 py-2 font-medium text-white">
          View in Browse
        </a>
      </div>
    );
  }

  const totalOpen = data.openItems.length;

  return (
    <div className="space-y-4">
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
            {analyzing ? "Analyzing…" : "AI pre-fill ↓"}
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
          <span className="text-xs font-semibold uppercase text-slate-500">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
          />
        </label>
      </div>

      {/* Carried-forward open items */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-lg font-semibold">
          Open items to review ({totalOpen})
        </h2>
        <p className="mb-3 text-xs text-slate-500">
          Go through each item and record what happened. Set status to <em>Completed</em> to close it.
          Leave one as “No update” to carry it forward unchanged.
        </p>

        {totalOpen === 0 ? (
          <p className="rounded border border-dashed border-slate-300 p-4 text-sm text-slate-500">
            No open items to carry forward from this project. You can still add new minutes below.
          </p>
        ) : (
          data.areas.map((area) => (
            <div key={area} className="mb-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">{area}</div>
              <div className="space-y-3">
                {(byArea[area] ?? []).map((it) => {
                  const u = updates[it.id];
                  return (
                    <div key={it.id} className="rounded-lg border-l-4 border-l-amber-500 bg-amber-50 p-3">
                      {/* Original item summary — the item's own fields (type,
                          status, owner, due) are editable right here. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{it.title}</span>
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
                                <span className="text-slate-400">{fmtDate(h.date)} · {h.meetingTitle}</span>
                                <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500">{h.type}</span>
                                <span className="text-slate-400"> · {h.status}</span>
                                {h.description ? <> — {h.description}</> : null}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}

                      {/* Update controls — the item's own update is just a note.
                          Its state (type/status/owner/due) is edited on the header
                          above; set Status → Completed there to close it. */}
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
                            {(childrenByParent[it.id] ?? []).map((child) => {
                              const cu = updates[child.id];
                              if (!cu) return null;
                              return (
                                <div key={child.id} className="rounded border-l-4 border-l-brand-blue bg-blue-50 p-2">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">{child.title}</span>
                                    <span className="text-[11px] italic text-slate-500">{child.type}</span>
                                    <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-slate-500">{child.status}</span>
                                  </div>
                                  {child.description && (
                                    <div className="mt-0.5 text-xs text-slate-500">{child.description}</div>
                                  )}
                                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                                    <label className="flex items-center gap-1 text-slate-600">
                                      <input
                                        type="checkbox"
                                        checked={cu.noUpdate}
                                        onChange={(e) => setUpdate(child.id, { noUpdate: e.target.checked })}
                                      />
                                      No action
                                    </label>
                                    {!cu.noUpdate && (
                                      <button
                                        type="button"
                                        onClick={() => setUpdate(child.id, { status: "Completed", note: cu.note || "Marked complete." })}
                                        className="rounded border border-emerald-300 px-2 py-0.5 font-medium text-emerald-700 hover:bg-emerald-50"
                                      >
                                        ✓ Mark complete
                                      </button>
                                    )}
                                  </div>
                                  {!cu.noUpdate && (
                                    <>
                                      <textarea
                                        value={cu.note}
                                        onChange={(e) => setUpdate(child.id, { note: e.target.value })}
                                        rows={1}
                                        placeholder="What happened with this item?"
                                        className="mt-1 w-full rounded border border-slate-300 p-1 text-sm"
                                      />
                                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                                        <span>Status</span>
                                        <select
                                          value={cu.status}
                                          onChange={(e) => setUpdate(child.id, { status: e.target.value })}
                                          className="rounded border border-slate-300 p-1"
                                        >
                                          {STATUS_OPTIONS.map((s) => (
                                            <option key={s} value={s}>{s}</option>
                                          ))}
                                        </select>
                                      </div>
                                    </>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* New minutes raised under this item THIS meeting. */}
                        {u.subEntries.length > 0 && (
                          <div className="mt-3 space-y-2 border-t border-amber-200 pt-2">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                              Raised under this item
                            </div>
                            {u.subEntries.map((s, si) => (
                              <div key={si} className="rounded border-l-4 border-l-brand-blue bg-blue-50 p-2">
                                <div className="mb-1 flex items-center gap-2">
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
                          + Add note / to-do / devops under this item
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
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
          ))
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

        {newMinutes.some((m) => !data.areas.includes(m.area)) ? (
          <div className="space-y-2">
            {newMinutes.map((m, i) => (!data.areas.includes(m.area) ? renderNewMinuteEditor(m, i) : null))}
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
