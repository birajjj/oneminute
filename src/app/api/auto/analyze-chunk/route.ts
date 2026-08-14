import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { buildAutoPlan } from "@/lib/ai/auto-plan";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

// Analyses ONE chunk of a transcript. The client splits a long transcript and
// calls this sequentially (one chunk at a time), then merges the results — so
// each call stays well under Vercel's 60s cap. A short transcript is a single
// chunk, i.e. one call, same as before.
const BodySchema = z.object({
  chunk: z.string().min(1),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Titles already extracted from earlier chunks, so this one doesn't repeat them.
  priorTitles: z.array(z.string()).optional(),
  // Area names earlier chunks already used, so this chunk reuses them instead
  // of coining synonyms and scattering one meeting across many tabs.
  priorAreas: z.array(z.string()).optional(),
  // The FULL transcript, sent only on the first chunk, persisted once for the record.
  saveTranscript: z.string().optional()
});

export async function POST(req: NextRequest) {
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "chunk is required" }, { status: 400 });
    }
    const user = await requireUser();

    // Persist the full transcript once (first chunk), so it's kept regardless of
    // how the analysis goes.
    if (parsed.data.saveTranscript) {
      await db.analysisJob.create({
        data: {
          orgId: user.orgId,
          userId: user.id,
          kind: "auto",
          transcript: parsed.data.saveTranscript,
          status: "running",
          runToken: randomUUID()
        }
      });
    }

    // The Auto page is always a NEW meeting — skip the org-wide history so the
    // prompt stays small and fast (no follow-up detection here; that's the
    // Follow-up flow's job).
    const plan = await buildAutoPlan(user.orgId, parsed.data.chunk, parsed.data.today, {
      priorTitles: parsed.data.priorTitles,
      priorAreas: parsed.data.priorAreas,
      newMeetingOnly: true
    });
    return NextResponse.json(plan);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("analyze-chunk error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
