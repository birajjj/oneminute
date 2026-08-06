// Client-side chunking for long meetings. The browser splits the transcript and
// calls the analyse endpoint ONE CHUNK AT A TIME (sequentially — no rate-limit
// bursts), then merges the results. Committing a big plan is likewise split into
// a fast "start" call plus batched "minutes" calls. Every server call stays well
// under Vercel's 60s cap. A short transcript is a single chunk = one call, same
// as before. The tab must stay open while it runs.

import type { AutoPlan } from "@/lib/ai/auto-plan";
import type { FollowUpPlan, FollowUpUpdate } from "@/lib/ai/followup-plan";

const CHUNK_CHARS = 5000;
const MAX_CHUNKS = 40;
const MINUTE_BATCH = 6;

export interface ChunkProgress {
  done: number;
  total: number;
  phase: "analyzing" | "saving";
}

// Split on paragraph/line boundaries where possible so we never cut a sentence.
export function splitTranscript(text: string, size = CHUNK_CHARS): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= size) return [t];

  let chunkSize = size;
  if (Math.ceil(t.length / chunkSize) > MAX_CHUNKS) {
    chunkSize = Math.ceil(t.length / MAX_CHUNKS);
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < t.length) {
    if (t.length - start <= chunkSize) {
      chunks.push(t.slice(start).trim());
      break;
    }
    const window = t.slice(start, start + chunkSize);
    let cut =
      lastBoundary(window, "\n\n") ?? lastBoundary(window, "\n") ?? lastBoundary(window, " ") ?? window.length;
    if (cut < chunkSize * 0.5) cut = window.length;
    const piece = t.slice(start, start + cut).trim();
    if (piece) chunks.push(piece);
    start += cut;
  }
  return chunks.filter(Boolean);
}

function lastBoundary(s: string, needle: string): number | null {
  const i = s.lastIndexOf(needle);
  return i > 0 ? i + needle.length : null;
}

// ---------------------------------------------------------------------------

export async function analyzeAutoChunked(
  transcript: string,
  today: string,
  onProgress?: (p: ChunkProgress) => void
): Promise<AutoPlan> {
  const chunks = splitTranscript(transcript);
  let acc: AutoPlan | null = null;
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ done: i, total: chunks.length, phase: "analyzing" });
    const priorTitles: string[] = acc ? acc.minutes.map((m) => m.title).filter(Boolean) : [];
    const plan: AutoPlan = await postJson<AutoPlan>("/api/auto/analyze-chunk", {
      chunk: chunks[i],
      today,
      priorTitles,
      saveTranscript: i === 0 ? transcript : undefined
    });
    acc = acc ? mergeAutoPlans(acc, plan) : plan;
  }
  onProgress?.({ done: chunks.length, total: chunks.length, phase: "analyzing" });
  if (!acc) throw new Error("no transcript to analyze");
  return acc;
}

export async function analyzeFollowupChunked(
  transcript: string,
  parentMeetingId: string,
  onProgress?: (p: ChunkProgress) => void
): Promise<FollowUpPlan> {
  const chunks = splitTranscript(transcript);
  let acc: FollowUpPlan = { updates: [], newMinutes: [], summary: "" };
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ done: i, total: chunks.length, phase: "analyzing" });
    const priorTitles = acc.newMinutes.map((m) => m.title).filter(Boolean);
    const plan = await postJson<FollowUpPlan>("/api/followup/analyze-chunk", {
      parentMeetingId,
      chunk: chunks[i],
      priorTitles,
      saveTranscript: i === 0 ? transcript : undefined
    });
    acc = mergeFollowUpPlans(acc, plan);
  }
  onProgress?.({ done: chunks.length, total: chunks.length, phase: "analyzing" });
  return acc;
}

// Chunked commit: one fast "start", then batches of minutes.
export async function commitAutoChunked(
  plan: AutoPlan,
  onProgress?: (p: ChunkProgress) => void
): Promise<{
  meetingId: string;
  projectId: string;
  projectCreated: boolean;
  minutesSaved: number;
  warnings: string[];
}> {
  const start = await postJson<{ projectId: string; meetingId: string; projectCreated: boolean }>(
    "/api/auto/commit/start",
    { plan }
  );

  const approved = (plan.minutes || []).filter(
    (m) => m.approved && (m.title.trim() !== "" || (m.description ?? "").trim() !== "")
  );
  const batches: AutoPlan["minutes"][] = [];
  for (let i = 0; i < approved.length; i += MINUTE_BATCH) {
    batches.push(approved.slice(i, i + MINUTE_BATCH));
  }

  let saved = 0;
  const warnings: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    onProgress?.({ done: i, total: batches.length, phase: "saving" });
    const r = await postJson<{ saved: number; warnings: string[] }>("/api/auto/commit/minutes", {
      meetingId: start.meetingId,
      minutes: batches[i]
    });
    saved += r.saved;
    warnings.push(...r.warnings);
  }
  onProgress?.({ done: batches.length, total: batches.length, phase: "saving" });

  return {
    meetingId: start.meetingId,
    projectId: start.projectId,
    projectCreated: start.projectCreated,
    minutesSaved: saved,
    warnings
  };
}

// ---------------------------------------------------------------------------
// Merge helpers

function mergeAutoPlans(acc: AutoPlan, seg: AutoPlan): AutoPlan {
  const seen = new Set(acc.minutes.map((m) => m.title.trim().toLowerCase()).filter(Boolean));
  const minutes = [...acc.minutes];
  for (const m of seg.minutes) {
    const key = m.title.trim().toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    minutes.push(m);
  }
  return { ...acc, minutes };
}

function mergeFollowUpPlans(acc: FollowUpPlan, seg: FollowUpPlan): FollowUpPlan {
  const byId = new Map<string, FollowUpUpdate>();
  for (const u of acc.updates) byId.set(u.rootMinuteId, u);
  for (const u of seg.updates) {
    const prev = byId.get(u.rootMinuteId);
    if (!prev || u.discussed || !prev.discussed) byId.set(u.rootMinuteId, u);
  }

  const seen = new Set(acc.newMinutes.map((m) => m.title.trim().toLowerCase()).filter(Boolean));
  const newMinutes = [...acc.newMinutes];
  for (const m of seg.newMinutes) {
    const key = m.title.trim().toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    newMinutes.push(m);
  }

  return { updates: [...byId.values()], newMinutes, summary: acc.summary || seg.summary || "" };
}

// ---------------------------------------------------------------------------

// POST JSON with one retry on failure (a transient chunk error shouldn't sink
// the whole run). Undefined body fields are dropped by JSON.stringify.
async function postJson<T>(url: string, body: unknown, retries = 1): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(800);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
