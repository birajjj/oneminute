// Reusable meeting-audio recorder: captures mic + optional tab/system audio,
// records it as independent ~10-minute segments, and transcribes each segment
// (via /api/auto/transcribe) as it finishes — so even a 1-hour meeting is nearly
// done transcribing by the time you press Stop. Segmenting is invisible to the
// user: just Start / Stop. Shared by Auto Mode and the follow-up workspace.

import { useCallback, useEffect, useRef, useState } from "react";

const SEGMENT_MS = 10 * 60 * 1000;

export interface SegmentRecorder {
  transcript: string;
  setTranscript: (v: string) => void;
  clearTranscript: () => void;
  isRecording: boolean;
  isTranscribing: boolean;
  captureMic: boolean;
  setCaptureMic: (v: boolean) => void;
  captureTab: boolean;
  setCaptureTab: (v: boolean) => void;
  segTotal: number;
  segDone: number;
  error: string;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
}

export function useSegmentRecorder(storageKey?: string): SegmentRecorder {
  const [transcript, setTranscriptState] = useState("");

  // Persist the transcript so a draft survives analyze/commit errors, "Start
  // Over", navigation, and refreshes. Cleared only by clearTranscript (which the
  // caller invokes after a successful save, or the user via a Clear button).
  const setTranscript = useCallback(
    (v: string) => {
      setTranscriptState(v);
      if (storageKey && typeof window !== "undefined") {
        try {
          if (v) window.localStorage.setItem(storageKey, v);
          else window.localStorage.removeItem(storageKey);
        } catch { /* storage unavailable */ }
      }
    },
    [storageKey]
  );

  // Restore any saved draft on mount.
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) setTranscriptState(saved);
    } catch { /* ignore */ }
  }, [storageKey]);

  const clearTranscript = useCallback(() => setTranscript(""), [setTranscript]);

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [captureMic, setCaptureMic] = useState(true);
  const [captureTab, setCaptureTab] = useState(true);
  const [segTotal, setSegTotal] = useState(0);
  const [segDone, setSegDone] = useState(0);
  const [error, setError] = useState("");

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
    cycleTimerRef.current = setInterval(cycleSegment, SEGMENT_MS);
  }

  // Records one segment on the shared mixed-audio destination. Each segment is a
  // complete, standalone audio file, so it can be transcribed on its own.
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
      pendingRef.current.push(transcribeSegment(index, blob));
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    setSegTotal((n) => Math.max(n, index + 1));
  }

  // Ends the current segment (triggering its transcription) and immediately
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

    // Finalize the last segment; wait for 'stop' so its transcription is queued.
    const rec = recorderRef.current;
    await new Promise<void>((resolve) => {
      if (!rec || rec.state === "inactive") { resolve(); return; }
      rec.addEventListener("stop", () => resolve(), { once: true });
      rec.stop();
    });

    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streamsRef.current = [];
    await audioCtxRef.current?.close();
    audioCtxRef.current = null;
    destRef.current = null;

    if (pendingRef.current.length === 0) { setError("No audio captured."); return; }

    setIsTranscribing(true);
    try {
      await Promise.all(pendingRef.current);
    } finally {
      setIsTranscribing(false);
    }
  }

  // Uploads one recorded segment for transcription and slots its text into the
  // ordered transcript (segments may finish out of order — index keeps order).
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

  return {
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
    error,
    startRecording,
    stopRecording
  };
}
