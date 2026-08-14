import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadFollowUpData } from "@/lib/followup";
import { buildFollowUpPlan } from "@/lib/ai/followup-plan";

export const runtime = "nodejs";
export const maxDuration = 60;

// Analyses ONE chunk of a follow-up transcript. The client splits a long
// transcript and calls this sequentially, then merges — so each call stays under
// Vercel's 60s cap. A short transcript is a single chunk (one call), as before.
const BodySchema = z.object({
  parentMeetingId: z.string().min(1),
  chunk: z.string().min(1),
  priorTitles: z.array(z.string()).optional(),
  priorAreas: z.array(z.string()).optional(),
  saveTranscript: z.string().optional()
});

export async function POST(req: NextRequest) {
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "parentMeetingId and chunk are required" }, { status: 400 });
    }
    const user = await requireUser();

    if (parsed.data.saveTranscript) {
      await db.analysisJob.create({
        data: {
          orgId: user.orgId,
          userId: user.id,
          kind: "followup",
          transcript: parsed.data.saveTranscript,
          status: "running",
          runToken: randomUUID()
        }
      });
    }

    // Re-load the open items server-side so the AI only ever sees this org's real
    // items (never client-supplied ids), and their order is stable across chunks.
    const data = await loadFollowUpData(user.orgId, parsed.data.parentMeetingId);
    if (!data) {
      return NextResponse.json({ error: "meeting not found" }, { status: 404 });
    }

    const users = (
      await db.user.findMany({
        where: { orgId: user.orgId, isRoster: true },
        select: { displayName: true }
      })
    ).map((u) => u.displayName);

    const plan = await buildFollowUpPlan(data.openItems, users, parsed.data.chunk, {
      priorTitles: parsed.data.priorTitles,
      priorAreas: parsed.data.priorAreas
    });
    return NextResponse.json(plan);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("followup analyze-chunk error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
