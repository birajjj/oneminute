import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadFollowUpData } from "@/lib/followup";
import { buildFollowUpPlan } from "@/lib/ai/followup-plan";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  parentMeetingId: z.string().min(1),
  transcript: z.string().min(1)
});

export async function POST(req: NextRequest) {
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "parentMeetingId and transcript are required" }, { status: 400 });
    }

    const user = await requireUser();

    // Persist the transcript BEFORE analysis, so it's never lost — even if the
    // analysis call fails or times out. The result is written back on success.
    const record = await db.analysisJob.create({
      data: {
        orgId: user.orgId,
        userId: user.id,
        kind: "followup",
        transcript: parsed.data.transcript,
        status: "running",
        runToken: randomUUID()
      }
    });

    // Re-load the open items server-side so the AI only ever sees this org's
    // real items (never client-supplied ids).
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

    const plan = await buildFollowUpPlan(data.openItems, users, parsed.data.transcript);

    await db.analysisJob.update({
      where: { id: record.id },
      data: { result: plan as object, status: "done", segmentsDone: 1 }
    });

    return NextResponse.json(plan);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("followup analyze error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
