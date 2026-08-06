// Client helper: run an AI analysis as an async job so a long transcript is
// processed in <60s segments server-side (never hitting Vercel's 60s cap).
// Creates the job, polls its status, and nudges it if the server-side chain
// stalls, resolving with the final plan. The same UI (Auto review / Follow-up
// pre-fill) consumes the result exactly as it did the old one-shot response.

export interface JobProgress {
  status: string; // queued | running | done | error
  segmentsDone: number;
  segmentsTotal: number;
}

export interface RunJobOptions {
  onProgress?: (p: JobProgress) => void;
  signal?: AbortSignal;
}

export async function runAnalysisJob<T>(
  body: { kind: "auto" | "followup"; transcript: string; today?: string; parentMeetingId?: string },
  opts: RunJobOptions = {}
): Promise<T> {
  const res = await fetch("/api/jobs/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (!res.ok) throw new Error(await res.text());
  const { jobId, segmentsTotal } = await res.json();
  opts.onProgress?.({ status: "queued", segmentsDone: 0, segmentsTotal: segmentsTotal ?? 1 });
  return pollJob<T>(jobId, opts);
}

async function pollJob<T>(jobId: string, opts: RunJobOptions): Promise<T> {
  const POLL_MS = 2500;
  const NUDGE_AFTER = 3; // ~7.5s of no progress → nudge the next segment
  let lastDone = -1;
  let stalledPolls = 0;

  for (;;) {
    await sleep(POLL_MS, opts.signal);

    const res = await fetch(`/api/jobs/${jobId}`, { signal: opts.signal });
    if (!res.ok) throw new Error(await res.text());
    const job = await res.json();
    opts.onProgress?.({
      status: job.status,
      segmentsDone: job.segmentsDone,
      segmentsTotal: job.segmentsTotal
    });

    if (job.status === "done") return job.result as T;
    if (job.status === "error") throw new Error(job.error || "analysis failed");

    // Watchdog: if the segment count hasn't advanced for a few polls, the
    // self-trigger chain may have dropped (e.g. the tab was throttled) — nudge it.
    if (job.segmentsDone === lastDone) {
      if (++stalledPolls >= NUDGE_AFTER) {
        stalledPolls = 0;
        nudge(jobId, opts.signal);
      }
    } else {
      lastDone = job.segmentsDone;
      stalledPolls = 0;
    }
  }
}

function nudge(jobId: string, signal?: AbortSignal) {
  fetch(`/api/jobs/${jobId}/step`, { method: "POST", signal }).catch(() => {});
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}
