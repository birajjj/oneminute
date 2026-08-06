import { NextRequest, NextResponse } from "next/server";
import { commitAutoPlanMinutes } from "@/lib/ai/auto-commit";
import type { PlanMinute } from "@/lib/ai/auto-plan";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

// Phase 2 of a chunked commit: write one batch of minutes to an existing
// meeting. Called sequentially by the client until all batches are saved.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { meetingId?: string; minutes?: PlanMinute[] };
    if (!body.meetingId || !Array.isArray(body.minutes)) {
      return NextResponse.json({ error: "meetingId and minutes are required" }, { status: 400 });
    }
    const user = await requireUser();
    const result = await commitAutoPlanMinutes(user.orgId, body.meetingId, body.minutes);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("commit minutes error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
