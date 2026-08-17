"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AutoPlan } from "@/lib/ai/auto-plan";
import { useSegmentRecorder } from "@/lib/useSegmentRecorder";
import { analyzeAutoChunked, commitAutoChunked } from "@/lib/chunk-analyze";
import { TagChips } from "@/components/TagChips";
import { downloadTranscript } from "@/lib/download-transcript";
import BusyOverlay from "@/components/BusyOverlay";

// The page is manual-first: you land straight in the editable form and can fill
// it in by hand. Recording / pasting a transcript is an optional accelerator
// that FILLS the same form (mirrors the follow-up workspace's "AI pre-fill").
type Step = "edit" | "analyzing" | "done";

export interface Member {
  id: string;
  displayName: string;
}

// Reference data (mirrors on-prem dbo.Type and dbo.Status).
const TYPE_OPTIONS = ["Note", "To-Do", "Action", "Devops"];
const STATUS_OPTIONS = ["New", "Initiated", "In Progress", "Resolved", "Closed", "Cancelled"];

// Today's date in the USER's timezone (not UTC). `toISOString()` would give the
// UTC date, which is a day behind for +hours zones in the morning.
function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Local now as a datetime-local value (YYYY-MM-DDTHH:mm) for the date+time input.
function nowLocalDateTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Normalize a stored meetingDate (date-only from the AI, or a datetime-local the
// user picked) into a datetime-local value for the input.
function toDateTimeLocalValue(s: string): string {
  if (!s) return nowLocalDateTime();
  if (s.includes("T")) return s.slice(0, 16);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${s}T${p(now.getHours())}:${p(now.getMinutes())}`;
}

// The picked date/time → a full ISO instant. A datetime-local value is the user's
// local wall clock, so `new Date()` parses it in their timezone; a bare date is
// anchored at the current local time-of-day.
function localDateToISO(dateStr: string): string {
  const s = dateStr.trim();
  const now = new Date();
  if (s.includes("T")) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? now.toISOString() : d.toISOString();
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return now.toISOString();
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    now.getHours(), now.getMinutes(), now.getSeconds()
  );
  return d.toISOString();
}

function emptyMinute(area = "General"): AutoPlan["minutes"][number] {
  return {
    type: "new",
    referenceMinuteId: null,
    referenceMinuteTitle: null,
    statusChange: "",
    parentTitle: "",
    area,
    title: "",
    description: "",
    minuteType: "Note",
    status: "New",
    assignedTo: "",
    dueDate: "",
    isDevopsItem: false,
    tags: [],
    confidence: "high",
    approved: true,
    devopsAction: "none",
    devopsProject: "",
    devopsWorkItemType: "User Story",
    devopsWorkItemId: ""
  };
}

function emptyPlan(): AutoPlan {
  return {
    project: {
      action: "create_new",
      existingProjectId: null,
      existingProjectName: null,
      newProjectName: "",
      reason: "",
      confidence: ""
    },
    meeting: {
      action: "new",
      followUpToMeetingId: null,
      followUpToMeetingTitle: null,
      title: "",
      description: "",
      meetingDate: todayLocal(),
      attendees: "",
      reason: "",
      confidence: ""
    },
    minutes: [],
    summary: ""
  };
}

export default function AutoModeClient({
  members,
  projects,
  meetings,
  devopsEnabled
}: {
  members: Member[];
  projects: { id: string; name: string }[];
  meetings: { id: string; title: string; date: string; projectId: string }[];
  devopsEnabled: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("edit");
  const [plan, setPlan] = useState<AutoPlan>(emptyPlan());
  const [analysisProgress, setAnalysisProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [result, setResult] = useState<
    { minutesSaved: number; projectCreated: boolean; meetingId?: string; warnings?: string[] } | null
  >(null);
  const [error, setError] = useState("");
  // The AI panel starts open so recording/pasting is immediately available.
  const [aiOpen, setAiOpen] = useState(true);

  // Real DevOps projects for the "Create work item" dropdown. Loaded lazily so a
  // slow or unreachable TFS never blocks the page; empty => free-text fallback.
  const [devopsProjects, setDevopsProjects] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (!devopsEnabled) return;
    let cancelled = false;
    fetch("/api/devops/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.projects) setDevopsProjects(data.projects);
      })
      .catch(() => { /* leave empty -> the review falls back to a text box */ });
    return () => { cancelled = true; };
  }, [devopsEnabled]);

  // The mic/tab segment recorder + transcription pipeline lives in a shared hook.
  const {
    transcript,
    setTranscript,
    clearTranscript,
    isRecording,
    isTranscribing,
    captureMic,
    setCaptureMic,
    captureTab,
    setCaptureTab,
    segTotal,
    segDone,
    error: recorderError,
    startRecording,
    stopRecording
  } = useSegmentRecorder("oneminute:auto:transcript");

  async function analyze() {
    if (!transcript.trim()) return;
    setError("");
    setStep("analyzing");
    setAnalysisProgress(null);
    try {
      // Long transcripts are analysed in chunks (one call at a time) so no single
      // request hits Vercel's 60s cap. Send the user's local date so the AI
      // defaults meetings to today in THEIR timezone, not the server's UTC day.
      const result = await analyzeAutoChunked(transcript, todayLocal(), (p) =>
        setAnalysisProgress({ done: p.done, total: p.total })
      );
      // The AI FILLS the same form you could have typed yourself.
      setPlan(result);
      setStep("edit");
    } catch (e) {
      setError("Analyze failed: " + (e instanceof Error ? e.message : "unknown"));
      setStep("edit");
    } finally {
      setAnalysisProgress(null);
    }
  }

  async function commit() {
    setError("");
    try {
      // Convert the picked date to a full local instant so the server stores the
      // exact moment and Browse renders it on the right day in the user's zone.
      const planForCommit = {
        ...plan,
        meeting: { ...plan.meeting, meetingDate: localDateToISO(plan.meeting.meetingDate) }
      };
      // Chunked commit: create the meeting first, then save minutes in batches,
      // so a big meeting never hits Vercel's 60s cap.
      const r = await commitAutoChunked(planForCommit);
      clearTranscript(); // committed — the draft is done with
      // Warnings (e.g. a DevOps item that failed) matter — pause on them.
      // Otherwise jump straight to Browse with the new meeting selected.
      if (r.warnings.length > 0) {
        setResult({
          minutesSaved: r.minutesSaved,
          projectCreated: r.projectCreated,
          meetingId: r.meetingId,
          warnings: r.warnings
        });
        setStep("done");
      } else {
        router.push(`/browse?meeting=${r.meetingId}`);
      }
    } catch (e) {
      setError("Commit failed: " + (e instanceof Error ? e.message : "unknown"));
    }
  }

  // Note: reset does NOT clear the transcript, so "Start Over" keeps it for
  // re-analysis. It's cleared on a successful commit, or via the Clear button.
  function reset() {
    setStep("edit");
    setPlan(emptyPlan());
    setResult(null);
    setError("");
  }

  // ---- render ----

  return (
    <div className="space-y-4">
      {step === "edit" && (
        <div className="rounded-lg border-2 border-dashed border-brand-pink/50 bg-white p-4">
          <button
            onClick={() => setAiOpen((o) => !o)}
            className="mb-2 flex w-full items-center gap-2 text-left text-sm font-semibold text-brand-purple"
          >
            <span>{aiOpen ? "▾" : "▸"}</span>
            Optional — record or paste a transcript, and let AI fill the form below
          </button>
          {aiOpen && (
          <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {!isRecording ? (
              <button
                onClick={startRecording}
                disabled={isTranscribing}
                className="rounded bg-emerald-500 px-4 py-2 font-medium text-white disabled:opacity-50"
              >
                Start Recording
              </button>
            ) : (
              <button onClick={stopRecording} className="rounded bg-red-500 px-4 py-2 font-medium text-white">
                Stop
              </button>
            )}
            <button
              onClick={analyze}
              disabled={!transcript.trim() || isRecording || isTranscribing}
              className="rounded bg-brand-purple px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              Analyze with AI →
            </button>
            <button
              onClick={() =>
                downloadTranscript({
                  title: plan.meeting.title || "New meeting",
                  date: plan.meeting.meetingDate || new Date().toISOString(),
                  transcript
                })
              }
              disabled={!transcript.trim()}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-600 disabled:opacity-40"
              title="Save the transcript as a readable text file (who said what)"
            >
              ⬇ Transcript
            </button>
            <button
              onClick={clearTranscript}
              disabled={!transcript.trim() || isRecording || isTranscribing}
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-600 disabled:opacity-40"
              title="Clear the transcript"
            >
              Clear
            </button>
            <label className="ml-2 flex items-center gap-1 text-sm">
              <input type="checkbox" checked={captureMic} onChange={(e) => setCaptureMic(e.target.checked)} disabled={isRecording} /> Mic
            </label>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={captureTab} onChange={(e) => setCaptureTab(e.target.checked)} disabled={isRecording} /> Tab audio
            </label>
            {isRecording && (
              <span className="flex items-center gap-1.5 text-sm text-red-600">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                Recording
                {segDone < segTotal && (
                  <span className="text-blue-600">· transcribing {segDone}/{segTotal}</span>
                )}
              </span>
            )}
            {!isRecording && isTranscribing && (
              <span className="text-sm text-blue-600">
                Transcribing {segDone}/{segTotal}…
              </span>
            )}
          </div>
          <p className="mb-2 text-xs text-slate-500">
            Online meeting? Pick <b>“Entire Screen”</b> and turn on <b>“Also share system audio”</b> to capture other
            participants. In a browser tab? Use <b>“Chrome Tab”</b>. In-person? Untick <b>Tab audio</b> (mic only).
          </p>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            readOnly={isRecording || isTranscribing}
            placeholder="Record audio, or paste a transcript here directly."
            className="h-56 w-full resize-y rounded border border-slate-300 p-3 text-sm"
          />
          </>
          )}
        </div>
      )}

      {step === "analyzing" && (
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-6">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-brand-purple" />
          <div>
            <span className="font-medium">
              Analyzing transcript…
              {analysisProgress && analysisProgress.total > 1
                ? ` part ${Math.min(analysisProgress.done + 1, analysisProgress.total)} of ${analysisProgress.total}`
                : ""}
            </span>
            {analysisProgress && analysisProgress.total > 1 && (
              <p className="mt-0.5 text-sm text-slate-500">
                Long meeting — analysing in parts. Keep this tab open until it finishes.
              </p>
            )}
          </div>
        </div>
      )}

      {step === "edit" && (
        <PlanReview plan={plan} members={members} projects={projects} meetings={meetings} devopsEnabled={devopsEnabled} devopsProjects={devopsProjects} onChange={setPlan} onBack={reset} onCommit={commit} />
      )}

      {step === "done" && result && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-lg font-bold text-white">✓</div>
            <div className="flex-1">
              <div className="font-semibold">
                Saved {result.minutesSaved} minute(s)
                {result.projectCreated && <span className="ml-2 rounded bg-brand-purple px-1.5 py-0.5 text-xs text-white">new project</span>}
              </div>
              {result.warnings && result.warnings.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-amber-700">
                  {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>
            <a href={`/browse?meeting=${result.meetingId ?? ""}`} className="rounded border border-emerald-300 px-4 py-2 font-medium text-emerald-700">View in Browse</a>
            <button onClick={reset} className="rounded bg-brand-blue px-4 py-2 font-medium text-white">Capture another</button>
          </div>
        </div>
      )}

      {(error || recorderError) && (
        <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error || recorderError}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PlanReview({
  plan,
  members,
  projects,
  meetings,
  devopsEnabled,
  devopsProjects,
  onChange,
  onBack,
  onCommit
}: {
  plan: AutoPlan;
  members: Member[];
  projects: { id: string; name: string }[];
  meetings: { id: string; title: string; date: string; projectId: string }[];
  devopsEnabled: boolean;
  devopsProjects: { id: string; name: string }[];
  onChange: (p: AutoPlan) => void;
  onBack: () => void;
  onCommit: () => void;
}) {
  const [committing, setCommitting] = useState(false);
  // Count only minutes that will actually save — must match the commit filter
  // A minute saves if it has a title OR a description — this must match the
  // commit filter so the button never enables for minutes that won't persist.
  const approvedCount = plan.minutes.filter(
    (m) => m.approved && (m.title.trim() || m.description.trim())
  ).length;
  // Empty minutes (no title AND no description) won't save — warn if any.
  const emptyCount = plan.minutes.filter(
    (m) => m.approved && !m.title.trim() && !m.description.trim()
  ).length;

  function updateMinute(i: number, patch: Partial<AutoPlan["minutes"][number]>) {
    const minutes = plan.minutes.map((m, idx) => (idx === i ? { ...m, ...patch } : m));
    onChange({ ...plan, minutes });
  }

  // Render order: each top-level item followed by the tasks filed under it, so
  // a workstream and its to-dos stay together while you type.
  const ordered = (() => {
    const out: { m: AutoPlan["minutes"][number]; i: number; nested: boolean }[] = [];
    const withIndex = plan.minutes.map((m, i) => ({ m, i }));
    const taken = new Set<number>();
    for (const { m, i } of withIndex) {
      if (m.parentTitle?.trim()) continue; // placed under its parent below
      out.push({ m, i, nested: false });
      taken.add(i);
      for (const c of withIndex) {
        if (c.i === i || taken.has(c.i)) continue;
        if (c.m.parentTitle?.trim() && c.m.parentTitle.trim() === m.title.trim()) {
          out.push({ m: c.m, i: c.i, nested: true });
          taken.add(c.i);
        }
      }
    }
    // Anything whose parent title no longer matches still has to be editable.
    for (const { m, i } of withIndex) if (!taken.has(i)) out.push({ m, i, nested: false });
    return out;
  })();

  // A task under an existing item — linked by the parent's title, which is how
  // the commit resolves nesting within this meeting.
  function addChild(parentTitle: string, area: string) {
    const child = { ...emptyMinute(area || "General"), parentTitle, minuteType: "To-Do" as const };
    onChange({ ...plan, minutes: [...plan.minutes, child] });
  }

  // ---- Project / meeting overrides (AI decides, user can change) ----
  function setProject(patch: Partial<AutoPlan["project"]>) {
    onChange({ ...plan, project: { ...plan.project, ...patch } });
  }
  function setMeeting(patch: Partial<AutoPlan["meeting"]>) {
    onChange({ ...plan, meeting: { ...plan.meeting, ...patch } });
  }
  function chooseProjectAction(action: "use_existing" | "create_new") {
    if (action === "create_new") {
      // A brand-new project has no prior meetings to follow up.
      onChange({
        ...plan,
        project: { ...plan.project, action },
        meeting: { ...plan.meeting, action: "new", followUpToMeetingId: null, followUpToMeetingTitle: null }
      });
    } else {
      setProject({ action });
    }
  }
  function selectExistingProject(id: string) {
    const p = projects.find((x) => x.id === id);
    // Keep the follow-up only if that meeting belongs to the newly chosen project.
    const keepFollowUp =
      !!plan.meeting.followUpToMeetingId &&
      meetings.some((m) => m.id === plan.meeting.followUpToMeetingId && m.projectId === id);
    onChange({
      ...plan,
      project: {
        ...plan.project,
        action: "use_existing",
        existingProjectId: id || null,
        existingProjectName: p?.name ?? null
      },
      meeting: keepFollowUp
        ? plan.meeting
        : { ...plan.meeting, followUpToMeetingId: null, followUpToMeetingTitle: null }
    });
  }
  function selectFollowUpMeeting(id: string) {
    const m = meetings.find((x) => x.id === id);
    setMeeting({ followUpToMeetingId: id || null, followUpToMeetingTitle: m?.title ?? null });
  }

  // Meetings available to follow up = those in the currently selected project.
  const meetingsInProject =
    plan.project.action === "use_existing" && plan.project.existingProjectId
      ? meetings.filter((m) => m.projectId === plan.project.existingProjectId)
      : [];
  const canFollowUp = meetingsInProject.length > 0;

  // Commit is only valid once the project target is fully specified.
  const projectValid =
    plan.project.action === "use_existing"
      ? !!plan.project.existingProjectId
      : !!plan.project.newProjectName?.trim();

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      {committing && (
        <BusyOverlay
          message="Please wait"
          detail="Saving and committing your meeting..."
        />
      )}

      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        {/* PROJECT — AI pre-selects; user can override */}
        <div className="rounded border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase text-slate-500">Project</div>
          <div className="mt-1.5 flex gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={plan.project.action === "use_existing"}
                onChange={() => chooseProjectAction("use_existing")}
              />
              Existing
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={plan.project.action === "create_new"}
                onChange={() => chooseProjectAction("create_new")}
              />
              New
            </label>
          </div>
          {plan.project.action === "use_existing" ? (
            <select
              value={plan.project.existingProjectId ?? ""}
              onChange={(e) => selectExistingProject(e.target.value)}
              className="mt-1.5 w-full rounded border border-slate-300 p-1 text-sm"
            >
              <option value="">— Select a project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          ) : (
            <input
              value={plan.project.newProjectName ?? ""}
              onChange={(e) => setProject({ newProjectName: e.target.value })}
              placeholder="New project name"
              className="mt-1.5 w-full rounded border border-slate-300 p-1 text-sm"
            />
          )}
          {plan.project.reason && (
            <div className="mt-1 text-xs text-slate-500">AI: {plan.project.reason}</div>
          )}
        </div>

        {/* MEETING — new, or a follow-up of an existing meeting in this project */}
        <div className="rounded border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase text-slate-500">Meeting</div>
          <input
            value={plan.meeting.title}
            onChange={(e) => setMeeting({ title: e.target.value })}
            placeholder="Meeting title"
            className="mt-1.5 w-full rounded border border-slate-300 p-1 text-sm"
          />
          <div className="mt-1.5 flex gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={plan.meeting.action === "new"}
                onChange={() => setMeeting({ action: "new", followUpToMeetingId: null, followUpToMeetingTitle: null })}
              />
              New meeting
            </label>
            <label className={`flex items-center gap-1 ${canFollowUp ? "" : "text-slate-400"}`}>
              <input
                type="radio"
                checked={plan.meeting.action === "followup"}
                disabled={!canFollowUp}
                onChange={() => setMeeting({ action: "followup" })}
              />
              Follow-up of…
            </label>
          </div>
          {plan.meeting.action === "followup" && (
            <select
              value={plan.meeting.followUpToMeetingId ?? ""}
              onChange={(e) => selectFollowUpMeeting(e.target.value)}
              className="mt-1.5 w-full rounded border border-slate-300 p-1 text-sm"
            >
              <option value="">— All prior meetings —</option>
              {meetingsInProject.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} · {new Date(m.date).toLocaleDateString("en-AU")}
                </option>
              ))}
            </select>
          )}
          <label className="mt-1 block text-[11px] text-slate-500">
            Date &amp; time
            <input
              type="datetime-local"
              value={toDateTimeLocalValue(plan.meeting.meetingDate)}
              onChange={(e) => setMeeting({ meetingDate: e.target.value })}
              className="mt-0.5 block rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
            />
          </label>
        </div>
      </div>

      {plan.summary && (
        <div className="mb-3 rounded border-l-4 border-indigo-400 bg-indigo-50 p-2 text-sm">
          <span className="font-semibold text-indigo-700">Summary:</span> {plan.summary}
        </div>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Minutes ({approvedCount} of {plan.minutes.length} to save)
        </h3>
        <button
          onClick={() =>
            onChange({
              ...plan,
              // New rows inherit the last row's area so consecutive entries stay
              // in the same tab.
              minutes: [...plan.minutes, emptyMinute(plan.minutes.at(-1)?.area || "General")]
            })
          }
          className="rounded bg-brand-blue px-3 py-1 text-sm font-medium text-white"
        >
          + Add minute
        </button>
      </div>

      {plan.minutes.length === 0 && (
        <p className="rounded border border-dashed border-slate-300 p-4 text-sm text-slate-500">
          No minutes yet — click <b>+ Add minute</b> to write them yourself, or use the AI panel above to
          fill this form from a recording or transcript.
        </p>
      )}

      {emptyCount > 0 && (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠️ {emptyCount} minute(s) have neither a title nor a description and won&apos;t save. Fill in a
          title or description below, or remove them.
        </p>
      )}

      <div className="space-y-4">
        {ordered.map(({ m, i, nested }) => (
          <div
            key={i}
            className={`rounded border p-2 ${nested ? "ml-6 border-l-4 border-l-slate-300 bg-slate-50" : m.type === "followup" ? "border-l-4 border-l-amber-500 bg-amber-100" : "border-l-4 border-l-brand-blue bg-blue-100"} ${!m.approved ? "opacity-45" : ""}`}
          >
            <div className="mb-1 flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={m.approved} onChange={(e) => updateMinute(i, { approved: e.target.checked })} />
                {m.approved ? "Save" : "Skip"}
              </label>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${m.type === "followup" ? "bg-amber-200 text-amber-800" : "bg-blue-200 text-blue-800"}`}>
                {m.type}
              </span>
              <input value={m.title} onChange={(e) => updateMinute(i, { title: e.target.value })} placeholder="Title" className="flex-1 rounded border border-slate-300 p-1 text-sm" />
              <button
                onClick={() => onChange({ ...plan, minutes: plan.minutes.filter((_, idx) => idx !== i) })}
                className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                title="Remove this minute"
              >
                ✕
              </button>
            </div>
            {m.type === "followup" && (
              <div className="mb-1 rounded bg-amber-100 px-2 py-1 text-xs text-amber-800">
                Follows up: {m.referenceMinuteTitle || m.referenceMinuteId}
                {m.statusChange && <span className="ml-1 font-semibold">→ {m.statusChange}</span>}
              </div>
            )}
            {/* This task will be filed under an Action from this same meeting. */}
            {m.parentTitle && (
              <div className="mb-1 flex items-center gap-1 text-xs text-slate-500">
                <span>↳ under “{m.parentTitle}”</span>
                <button
                  onClick={() => updateMinute(i, { parentTitle: "" })}
                  className="rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  title="Keep this as a standalone item"
                >
                  ✕
                </button>
              </div>
            )}
            <textarea
              value={m.description}
              onChange={(e) => updateMinute(i, { description: e.target.value })}
              rows={nested ? 2 : 5}
              placeholder="What was discussed…"
              className="w-full resize-y rounded border border-slate-300 p-2 text-sm"
            />
            <div className="mt-1">
              <TagChips value={m.tags} onChange={(tags) => updateMinute(i, { tags })} />
            </div>
            <div className="mt-1 grid grid-cols-3 gap-1 text-xs">
              <input value={m.area} onChange={(e) => updateMinute(i, { area: e.target.value })} className="rounded border border-slate-300 p-1" placeholder="Area" />

              <select
                value={m.minuteType}
                onChange={(e) => updateMinute(i, { minuteType: e.target.value as never })}
                className="rounded border border-slate-300 p-1"
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>

              <select
                value={m.status}
                onChange={(e) => updateMinute(i, { status: e.target.value })}
                className="rounded border border-slate-300 p-1"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>

              <select
                value={m.assignedTo}
                onChange={(e) => updateMinute(i, { assignedTo: e.target.value })}
                className="rounded border border-slate-300 p-1"
              >
                <option value="">— Unassigned —</option>
                {/* Keep the AI's suggestion selectable even if it isn't in the roster */}
                {m.assignedTo && !members.some((mem) => mem.displayName === m.assignedTo) && (
                  <option value={m.assignedTo}>{m.assignedTo} (AI)</option>
                )}
                {members.map((mem) => (
                  <option key={mem.id} value={mem.displayName}>{mem.displayName}</option>
                ))}
              </select>

              <input type="date" value={m.dueDate} onChange={(e) => updateMinute(i, { dueDate: e.target.value })} className="rounded border border-slate-300 p-1" />
            </div>

            {/* DevOps controls — shown when the AI flags it, or the type is Devops */}
            {(m.isDevopsItem || m.minuteType === "Devops" || m.devopsAction !== "none") && (
              <div className="mt-2 rounded border border-orange-200 bg-orange-50 p-2">
                <div className="mb-1 flex items-center gap-3 text-xs">
                  <span className="font-semibold text-orange-700">DevOps</span>
                  {(["none", "create", "link"] as const).map((act) => (
                    <label key={act} className="flex items-center gap-1">
                      <input
                        type="radio"
                        checked={m.devopsAction === act}
                        onChange={() => updateMinute(i, { devopsAction: act })}
                      />
                      {act === "none" ? "No work item" : act === "create" ? "Create" : "Link existing"}
                    </label>
                  ))}
                  {!devopsEnabled && m.devopsAction !== "none" && (
                    <span className="text-orange-600">⚠ DevOps not connected yet — will be skipped</span>
                  )}
                </div>

                {m.devopsAction === "create" && (
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    {devopsProjects.length > 0 ? (
                      <select
                        value={m.devopsProject}
                        onChange={(e) => updateMinute(i, { devopsProject: e.target.value })}
                        className="rounded border border-slate-300 p-1"
                      >
                        <option value="">— Select project —</option>
                        {/* Keep the AI's suggestion selectable even if it isn't a real project */}
                        {m.devopsProject && !devopsProjects.some((p) => p.name === m.devopsProject) && (
                          <option value={m.devopsProject}>{m.devopsProject} (AI)</option>
                        )}
                        {devopsProjects.map((p) => (
                          <option key={p.id} value={p.name}>{p.name}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={m.devopsProject}
                        onChange={(e) => updateMinute(i, { devopsProject: e.target.value })}
                        className="rounded border border-slate-300 p-1"
                        placeholder="DevOps project (e.g. 3TT.OneMinute)"
                      />
                    )}
                    <select
                      value={m.devopsWorkItemType}
                      onChange={(e) => updateMinute(i, { devopsWorkItemType: e.target.value as never })}
                      className="rounded border border-slate-300 p-1"
                    >
                      <option value="User Story">User Story</option>
                      <option value="Bug">Bug</option>
                    </select>
                  </div>
                )}

                {m.devopsAction === "link" && (
                  <input
                    value={m.devopsWorkItemId}
                    onChange={(e) => updateMinute(i, { devopsWorkItemId: e.target.value })}
                    className="w-40 rounded border border-slate-300 p-1 text-xs"
                    placeholder="Work Item ID"
                  />
                )}
              </div>
            )}

            {/* Capture a concrete task under this item without leaving the row —
                it commits nested beneath it (raisedFromRootId). */}
            {!nested && (
              <button
                onClick={() => addChild(m.title, m.area)}
                disabled={!m.title.trim()}
                className="mt-2 rounded border border-dashed border-slate-400 px-2 py-1 text-xs text-slate-600 hover:bg-white disabled:opacity-40"
                title={m.title.trim() ? "Add a to-do / devops under this item" : "Give this item a title first"}
              >
                + to-do / devops under this
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-slate-200 pt-3">
        <button onClick={onBack} disabled={committing} className="rounded border border-slate-300 px-4 py-2 text-sm">← Start Over</button>
        <button
          onClick={async () => { setCommitting(true); await onCommit(); setCommitting(false); }}
          disabled={committing || approvedCount === 0 || !plan.meeting.title || !projectValid}
          className="ml-auto rounded bg-gradient-to-r from-brand-pink to-brand-purple px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {committing ? "Committing…" : `✓ Approve & Commit (${approvedCount})`}
        </button>
      </div>
    </div>
  );
}
