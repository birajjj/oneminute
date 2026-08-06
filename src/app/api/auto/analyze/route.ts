import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { buildAutoPlan } from "@/lib/ai/auto-plan";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  transcript: z.string().min(1),
  // The caller's local date (YYYY-MM-DD) so meetings default to the user's day,
  // not the server's UTC day.
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "transcript is required" }, { status: 400 });
    }

    const user = await requireUser();

    // Persist the transcript BEFORE analysis, so it's never lost — even if the
    // analysis call fails or times out. The result is written back on success.
    const record = await db.analysisJob.create({
      data: {
        orgId: user.orgId,
        userId: user.id,
        kind: "auto",
        transcript: parsed.data.transcript,
        status: "running",
        runToken: randomUUID()
      }
    });

    const plan = await buildAutoPlan(user.orgId, parsed.data.transcript, parsed.data.today);

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
    console.error("analyze error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
