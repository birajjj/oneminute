"use client";

import { useRef, useState } from "react";
import type { AutoPlan } from "@/lib/ai/auto-plan";

type Step = "record" | "analyzing" | "review" | "done";

export default function AutoModeClient() {
  const [step, setStep] = useState<Step>("record");
  const [transcript, setTranscript] = useState("");
  const [plan, setPlan] = useState<AutoPlan | null>(null);
  const [result, setResult] = useState<{ minutesSaved: number; projectCreated: boolean } | null>(null);
  const [error, setError] = useState("");

  // recording state
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [captureMic, setCaptureMic] = useState(true);
  const [captureTab, setCaptureTab] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);

  async function startRecording() {
    setError("");
    chunksRef.current = [];
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

    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    streams.forEach((s) => {
      if (s.getAudioTracks().length)
        audioCtx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
    });

    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) =>
      MediaRecorder.isTypeSupported(t)
    );
    const recorder = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    recorder.onstop = onRecordingStop;
    recorder.start(1000);

    recorderRef.current = recorder;
    streamsRef.current = streams;
    audioCtxRef.current = audioCtx;
    setIsRecording(true);
  }

  function stopRecording() {
    setIsRecording(false);
    recorderRef.current?.stop();
  }

  async function onRecordingStop() {
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streamsRef.current = [];
    await audioCtxRef.current?.close();
    audioCtxRef.current = null;

    if (chunksRef.current.length === 0) { setError("No audio captured."); return; }
    const blob = new Blob(chunksRef.current, { type: recorderRef.current?.mimeType || "audio/webm" });
    chunksRef.current = [];

    setIsTranscribing(true);
    try {
      const fd = new FormData();
      fd.append("audio", blob, "recording.webm");
      const res = await fetch("/api/auto/transcribe", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setTranscript((prev) => (prev ? prev + "\n\n" : "") + (data.transcript || ""));
    } catch (e) {
      setError("Transcription failed: " + (e instanceof Error ? e.message : "unknown"));
    } finally {
      setIsTranscribing(false);
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
            {isTranscribing && <span className="text-sm text-blue-600">Transcribing…</span>}
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
        <PlanReview plan={plan} onChange={setPlan} onBack={reset} onCommit={commit} />
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
  onChange,
  onBack,
  onCommit
}: {
  plan: AutoPlan;
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
              <input value={m.minuteType} onChange={(e) => updateMinute(i, { minuteType: e.target.value as never })} className="rounded border border-slate-300 p-1" placeholder="Type" />
              <input value={m.status} onChange={(e) => updateMinute(i, { status: e.target.value })} className="rounded border border-slate-300 p-1" placeholder="Status" />
              <input value={m.assignedTo} onChange={(e) => updateMinute(i, { assignedTo: e.target.value })} className="rounded border border-slate-300 p-1" placeholder="Assigned" />
              <input type="date" value={m.dueDate} onChange={(e) => updateMinute(i, { dueDate: e.target.value })} className="rounded border border-slate-300 p-1" />
            </div>
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
