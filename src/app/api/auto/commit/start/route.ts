import { NextRequest, NextResponse } from "next/server";
import { commitAutoPlanStart } from "@/lib/ai/auto-commit";
import type { AutoPlan } from "@/lib/ai/auto-plan";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

// Phase 1 of a chunked commit: create the project, meeting and areas. Fast — the
// minutes are written afterwards in batches via /api/auto/commit/minutes.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { plan?: AutoPlan; transcript?: string };
    if (!body.plan) {
      return NextResponse.json({ error: "plan is required" }, { status: 400 });
    }
    const user = await requireUser();
    const result = await commitAutoPlanStart(user.orgId, user.id, body.plan, body.transcript);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("commit start error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
