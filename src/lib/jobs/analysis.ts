// Async analysis jobs: process a long transcript one <60s segment at a time so
// Vercel's 60s function cap is never hit. A job is created with the full
// transcript; each "step" claims the job, analyses the next segment, merges the
// result, and (unless finished) re-triggers itself — so it completes even if the
// browser tab is closed. A stalled job (lock older than 90s) is reclaimable, so
// a status poll can heal a broken chain.
//
// SERVER-ONLY.

import { randomUUID } from "crypto";
import type { AnalysisJob } from "@prisma/client";
import { db } from "@/lib/db";
import { buildAutoPlan, type AutoPlan } from "@/lib/ai/auto-plan";
import { buildFollowUpPlan, type FollowUpPlan, type FollowUpUpdate } from "@/lib/ai/followup-plan";
import { loadFollowUpData } from "@/lib/followup";
import { segmentTranscript } from "@/lib/ai/segment";

export type JobKind = "auto" | "followup";

const STALE_MS = 90_000;

export async function createAnalysisJob(input: {
  orgId: string;
  userId: string | null;
  kind: JobKind;
  transcript: string;
  params: Record<string, unknown>;
}): Promise<AnalysisJob> {
  const segments = segmentTranscript(input.transcript);
  return db.analysisJob.create({
    data: {
      orgId: input.orgId,
      userId: input.userId,
      kind: input.kind,
      transcript: input.transcript,
      params: input.params as object,
      segmentsTotal: Math.max(1, segments.length),
      segmentsDone: 0,
      status: "queued",
      runToken: randomUUID()
    }
  });
}

// Atomically take the job for processing. Returns the fresh row if we won the
// lock, else null (another worker holds a fresh lock, or it's done/errored).
export async function claimJob(jobId: string): Promise<AnalysisJob | null> {
  const stale = new Date(Date.now() - STALE_MS);
  const res = await db.analysisJob.updateMany({
    where: {
      id: jobId,
      status: { in: ["queued", "running"] },
      OR: [{ lockedAt: null }, { lockedAt: { lt: stale } }]
    },
    data: { status: "running", lockedAt: new Date() }
  });
  if (res.count === 0) return null;
  return db.analysisJob.findUnique({ where: { id: jobId } });
}

// Analyse the next unprocessed segment of a CLAIMED job, merge it into the
// accumulated result, persist, and release the lock. Returns progress.
export async function runNextSegment(
  job: AnalysisJob
): Promise<{ done: boolean; segmentsDone: number; segmentsTotal: number }> {
  const segments = segmentTranscript(job.transcript);
  const total = Math.max(1, segments.length);
  const idx = job.segmentsDone;

  if (idx >= segments.length) {
    await db.analysisJob.update({
      where: { id: job.id },
      data: { status: "done", lockedAt: null }
    });
    return { done: true, segmentsDone: total, segmentsTotal: total };
  }

  const segment = segments[idx];
  const params = (job.params ?? {}) as { today?: string; parentMeetingId?: string };

  let merged: unknown;
  try {
    if (job.kind === "auto") {
      const acc = (job.result as AutoPlan | null) ?? null;
      const priorTitles = acc ? acc.minutes.map((m) => m.title).filter(Boolean) : [];
      const seg = await buildAutoPlan(job.orgId, segment, params.today, { priorTitles });
      merged = mergeAuto(acc, seg);
    } else {
      const acc =
        (job.result as FollowUpPlan | null) ?? { updates: [], newMinutes: [], summary: "" };
      const parentMeetingId = String(params.parentMeetingId || "");
      const data = await loadFollowUpData(job.orgId, parentMeetingId);
      if (!data) throw new Error("meeting not found");
      const users = (
        await db.user.findMany({
          where: { orgId: job.orgId, isRoster: true },
          select: { displayName: true }
        })
      ).map((u) => u.displayName);
      const priorTitles = acc.newMinutes.map((m) => m.title).filter(Boolean);
      const seg = await buildFollowUpPlan(data.openItems, users, segment, { priorTitles });
      merged = mergeFollowup(acc, seg);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "analysis failed";
    await db.analysisJob.update({
      where: { id: job.id },
      data: { status: "error", error: msg, lockedAt: null }
    });
    throw err;
  }

  const nextDone = idx + 1;
  const finished = nextDone >= segments.length;
  await db.analysisJob.update({
    where: { id: job.id },
    data: {
      result: merged as object,
      segmentsDone: nextDone,
      status: finished ? "done" : "running",
      // Release immediately so the next step (self-trigger or a status poll) can
      // claim without waiting out the stale window.
      lockedAt: null
    }
  });
  return { done: finished, segmentsDone: nextDone, segmentsTotal: total };
}

// Fire-and-forget trigger for the next segment. Best-effort: if it never lands,
// a status poll will find the job reclaimable and nudge it.
export async function triggerStep(origin: string, jobId: string, runToken: string): Promise<void> {
  try {
    await fetch(`${origin}/api/jobs/${jobId}/step`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-run-token": runToken }
    });
  } catch {
    /* ignore — poll-driven resume is the safety net */
  }
}

// ---------------------------------------------------------------------------
// Merge helpers — combine a segment's plan into the running accumulator.

function mergeAuto(acc: AutoPlan | null, seg: AutoPlan): AutoPlan {
  // The first segment establishes project / meeting / summary. Later segments
  // only contribute more minutes.
  if (!acc) return seg;
  const seen = new Set(acc.minutes.map((m) => m.title.trim().toLowerCase()).filter(Boolean));
  const minutes = [...acc.minutes];
  for (const m of seg.minutes) {
    const key = m.title.trim().toLowerCase();
    if (key && seen.has(key)) continue; // dedup items split across a boundary
    if (key) seen.add(key);
    minutes.push(m);
  }
  return { ...acc, minutes };
}

function mergeFollowup(acc: FollowUpPlan, seg: FollowUpPlan): FollowUpPlan {
  // updates: one per open item. A segment that DISCUSSED an item wins over an
  // earlier not-discussed entry; if several discussed it, the latest wins.
  const byId = new Map<string, FollowUpUpdate>();
  for (const u of acc.updates) byId.set(u.rootMinuteId, u);
  for (const u of seg.updates) {
    const prev = byId.get(u.rootMinuteId);
    if (!prev || u.discussed || !prev.discussed) byId.set(u.rootMinuteId, u);
  }

  // newMinutes: concat + dedup by title.
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
