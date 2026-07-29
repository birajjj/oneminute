"use client";

import { useEffect, useRef, useState } from "react";
import type { AutoPlan } from "@/lib/ai/auto-plan";

type Step = "record" | "analyzing" | "review" | "done";

export interface Member {
  id: string;
  displayName: string;
}

// Reference data (mirrors on-prem dbo.Type and dbo.Status).
const TYPE_OPTIONS = ["Note", "To-Do", "Action", "Devops"];
const STATUS_OPTIONS = ["New", "Initiated", "In Progress", "Completed", "Cancelled"];

// Long meetings are captured as independent ~10-minute audio segments, each
// transcribed on its own. This keeps every transcription request small and well
// under the serverless timeout, and lets earlier segments transcribe while
// recording continues — so even a 1-hour meeting is nearly done transcribing by
// the time you press Stop. To the user it's just record/stop; segmenting is
// invisible.
const SEGMENT_MS = 10 * 60 * 1000;

export default function AutoModeClient({
  members,
  devopsEnabled
}: {
  members: Member[];
  devopsEnabled: boolean;
}) {
  const [step, setStep] = useState<Step>("record");
  const [transcript, setTranscript] = useState("");
  const [plan, setPlan] = useState<AutoPlan | null>(null);
  const [result, setResult] = useState<{ minutesSaved: number; projectCreated: boolean } | null>(null);
  const [error, setError] = useState("");

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

  // recording state
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [captureMic, setCaptureMic] = useState(true);
  const [captureTab, setCaptureTab] = useState(true);
  // Progress across audio segments (long meetings record in ~10-min segments).
  const [segTotal, setSegTotal] = useState(0);
  const [segDone, setSegDone] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const cycleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segIndexRef = useRef(0);
  const transcriptPartsRef = useRef<string[]>([]);
  const pendingRef = useRef<Promise<void>[]>([]);
  const mimeRef = useRef<string>("audio/webm");

  async function startRecording() {
    setError("");
    if (!captureMic && !captureTab) {
      setError("Pick at least one audio source.");
      return;
    }

    const streams: MediaStream[] = [];
    if (captureTab) {
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        display.getVideoTracks().forEach((t) => t.stop());
        if (display.getAudioTracks().length > 0) streams.push(display);
        else display.getTracks().forEach((t) => t.stop());
      } catch { /* cancelled */ }
    }
    if (captureMic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        streams.push(mic);
      } catch { /* denied */ }
    }
    if (streams.length === 0) {
      setError("No audio source granted.");
      return;
    }

    // Mix every granted source into one destination stream. We reuse this
    // destination for every segment so the user is only prompted for mic/tab
    // audio once, at the start.
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    streams.forEach((s) => {
      if (s.getAudioTracks().length)
        audioCtx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
    });

    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) =>
      MediaRecorder.isTypeSupported(t)
    );

    // Fresh bookkeeping for this recording.
    mimeRef.current = mime || "audio/webm";
    destRef.current = dest;
    streamsRef.current = streams;
    audioCtxRef.current = audioCtx;
    segIndexRef.current = 0;
    transcriptPartsRef.current = [];
    pendingRef.current = [];
    setSegTotal(0);
    setSegDone(0);
    setTranscript("");

    setIsRecording(true);
    startSegment();
    // Roll over to a new segment every SEGMENT_MS so no single clip runs long.
    cycleTimerRef.current = setInterval(cycleSegment, SEGMENT_MS);
  }

  // Records one segment on the shared mixed-audio destination. Each segment is a
  // complete, standalone audio file (its own container header), so it can be
  // transcribed on its own the moment it finishes.
  function startSegment() {
    const dest = destRef.current;
    if (!dest) return;
    const index = segIndexRef.current++;
    const localChunks: Blob[] = [];

    const opts: MediaRecorderOptions = { audioBitsPerSecond: 48000 };
    if (mimeRef.current) opts.mimeType = mimeRef.current;
    const recorder = new MediaRecorder(dest.stream, opts);

    recorder.ondataavailable = (e) => { if (e.data.size) localChunks.push(e.data); };
    recorder.onstop = () => {
      if (localChunks.length === 0) return;
      const blob = new Blob(localChunks, { type: mimeRef.current });
      // Transcribe this segment now, in the background. Track the promise so
      // Stop can wait for every outstanding segment to finish.
      pendingRef.current.push(transcribeSegment(index, blob));
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    setSegTotal((n) => Math.max(n, index + 1));
  }

  // Ends the current segment (which triggers its transcription) and immediately
  // starts the next one on the same audio source. Fired by the cycle timer.
  function cycleSegment() {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    startSegment();
  }

  async function stopRecording() {
    if (cycleTimerRef.current) {
      clearInterval(cycleTimerRef.current);
      cycleTimerRef.current = null;
    }
    setIsRecording(false);

    // Finalize the last segment. Wait for its 'stop' to fire so the segment's
    // onstop (registered first) has queued its transcription before we await.
    const rec = recorderRef.current;
    await new Promise<void>((resolve) => {
      if (!rec || rec.state === "inactive") { resolve(); return; }
      rec.addEventListener("stop", () => resolve(), { once: true });
      rec.stop();
    });

    // Release the mic / tab audio.
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streamsRef.current = [];
    await audioCtxRef.current?.close();
    audioCtxRef.current = null;
    destRef.current = null;

    if (pendingRef.current.length === 0) { setError("No audio captured."); return; }

    // Wait for any still-running segment transcriptions to complete.
    setIsTranscribing(true);
    try {
      await Promise.all(pendingRef.current);
    } finally {
      setIsTranscribing(false);
    }
  }

  // Uploads one recorded segment for transcription and slots its text into the
  // ordered transcript. Segments may finish out of order, so we key by index to
  // keep them in sequence. A failed segment is left blank rather than aborting
  // the whole meeting.
  async function transcribeSegment(index: number, blob: Blob) {
    try {
      const fd = new FormData();
      fd.append("audio", blob, `segment-${index}.webm`);
      const res = await fetch("/api/auto/transcribe", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      transcriptPartsRef.current[index] = (data.transcript || "").trim();
    } catch (e) {
      transcriptPartsRef.current[index] = "";
      setError("A segment failed to transcribe: " + (e instanceof Error ? e.message : "unknown"));
    } finally {
      setSegDone((n) => n + 1);
      setTranscript(transcriptPartsRef.current.filter(Boolean).join("\n\n"));
    }
  }

  async function analyze() {
    if (!transcript.trim()) return;
    setError("");
    setStep("analyzing");
    try {
      const res = await fetch("/api/auto/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript })
      });
      if (!res.ok) throw new Error(await res.text());
      setPlan(await res.json());
      setStep("review");
    } catch (e) {
      setError("Analyze failed: " + (e instanceof Error ? e.message : "unknown"));
      setStep("record");
    }
  }

  async function commit() {
    if (!plan) return;
    setError("");
    try {
      const res = await fetch("/api/auto/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan })
      });
      if (!res.ok) throw new Error(await res.text());
      const r = await res.json();
      setResult(r);
      setStep("done");
    } catch (e) {
      setError("Commit failed: " + (e instanceof Error ? e.message : "unknown"));
    }
  }

  function reset() {
    setStep("record");
    setTranscript("");
    setPlan(null);
    setResult(null);
    setError("");
  }

  // ---- render ----

  return (
    <div className="space-y-4">
      {step === "record" && (
        <div className="rounded-lg border-2 border-brand-pink bg-white p-4">
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
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            readOnly={isRecording || isTranscribing}
            placeholder="Record audio, or paste a transcript here directly."
            className="h-96 w-full resize-y rounded border border-slate-300 p-3 text-sm"
          />
        </div>
      )}

      {step === "analyzing" && (
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-6">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-brand-purple" />
          <span className="font-medium">Analyzing transcript…</span>
        </div>
      )}

      {step === "review" && plan && (
        <PlanReview plan={plan} members={members} devopsEnabled={devopsEnabled} devopsProjects={devopsProjects} onChange={setPlan} onBack={reset} onCommit={commit} />
      )}

      {step === "done" && result && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-lg font-bold text-white">✓</div>
          <div className="flex-1">
            <div className="font-semibold">
              Saved {result.minutesSaved} minute(s)
              {result.projectCreated && <span className="ml-2 rounded bg-brand-purple px-1.5 py-0.5 text-xs text-white">new project</span>}
            </div>
          </div>
          <a href="/browse" className="rounded border border-emerald-300 px-4 py-2 font-medium text-emerald-700">View in Browse</a>
          <button onClick={reset} className="rounded bg-brand-blue px-4 py-2 font-medium text-white">Capture another</button>
        </div>
      )}

      {error && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PlanReview({
  plan,
  members,
  devopsEnabled,
  devopsProjects,
  onChange,
  onBack,
  onCommit
}: {
  plan: AutoPlan;
  members: Member[];
  devopsEnabled: boolean;
  devopsProjects: { id: string; name: string }[];
  onChange: (p: AutoPlan) => void;
  onBack: () => void;
  onCommit: () => void;
}) {
  const [committing, setCommitting] = useState(false);
  const approvedCount = plan.minutes.filter((m) => m.approved).length;

  function updateMinute(i: number, patch: Partial<AutoPlan["minutes"][number]>) {
    const minutes = plan.minutes.map((m, idx) => (idx === i ? { ...m, ...patch } : m));
    onChange({ ...plan, minutes });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase text-slate-500">Project</div>
          <div className="mt-1 text-sm">
            {plan.project.action === "use_existing"
              ? `Use existing: ${plan.project.existingProjectName || plan.project.existingProjectId}`
              : `Create new: ${plan.project.newProjectName}`}
          </div>
          {plan.project.reason && <div className="mt-1 text-xs text-slate-500">{plan.project.reason}</div>}
        </div>
        <div className="rounded border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase text-slate-500">Meeting</div>
          <input
            value={plan.meeting.title}
            onChange={(e) => onChange({ ...plan, meeting: { ...plan.meeting, title: e.target.value } })}
            className="mt-1 w-full rounded border border-slate-300 p-1 text-sm"
          />
          <div className="mt-1 text-xs text-slate-500">
            {plan.meeting.action === "followup" ? "Follow-up meeting" : "New meeting"} · {plan.meeting.meetingDate}
          </div>
        </div>
      </div>

      {plan.summary && (
        <div className="mb-3 rounded border-l-4 border-indigo-400 bg-indigo-50 p-2 text-sm">
          <span className="font-semibold text-indigo-700">Summary:</span> {plan.summary}
        </div>
      )}

      <h3 className="mb-2 text-sm font-semibold">
        Minutes ({approvedCount} of {plan.minutes.length} to save)
      </h3>

      <div className="space-y-2">
        {plan.minutes.map((m, i) => (
          <div
            key={i}
            className={`rounded border p-2 ${m.type === "followup" ? "border-l-4 border-l-amber-500 bg-amber-50" : "border-l-4 border-l-brand-blue bg-blue-50"} ${!m.approved ? "opacity-45" : ""}`}
          >
            <div className="mb-1 flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={m.approved} onChange={(e) => updateMinute(i, { approved: e.target.checked })} />
                {m.approved ? "Save" : "Skip"}
              </label>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${m.type === "followup" ? "bg-amber-200 text-amber-800" : "bg-blue-200 text-blue-800"}`}>
                {m.type}
              </span>
              <input value={m.title} onChange={(e) => updateMinute(i, { title: e.target.value })} className="flex-1 rounded border border-slate-300 p-1 text-sm" />
            </div>
            {m.type === "followup" && (
              <div className="mb-1 rounded bg-amber-100 px-2 py-1 text-xs text-amber-800">
                Follows up: {m.referenceMinuteTitle || m.referenceMinuteId}
                {m.statusChange && <span className="ml-1 font-semibold">→ {m.statusChange}</span>}
              </div>
            )}
            <textarea value={m.description} onChange={(e) => updateMinute(i, { description: e.target.value })} rows={2} className="w-full rounded border border-slate-300 p-1 text-sm" />
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
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-slate-200 pt-3">
        <button onClick={onBack} disabled={committing} className="rounded border border-slate-300 px-4 py-2 text-sm">← Start Over</button>
        <button
          onClick={async () => { setCommitting(true); await onCommit(); setCommitting(false); }}
          disabled={committing || approvedCount === 0 || !plan.meeting.title}
          className="ml-auto rounded bg-gradient-to-r from-brand-pink to-brand-purple px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {committing ? "Committing…" : `✓ Approve & Commit (${approvedCount})`}
        </button>
      </div>
    </div>
  );
}
