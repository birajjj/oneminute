import { NextRequest, NextResponse } from "next/server";
import { commitAutoPlan } from "@/lib/ai/auto-commit";
import type { AutoPlan } from "@/lib/ai/auto-plan";
import { currentOrgId, currentUserId } from "@/lib/dev-context";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { plan?: AutoPlan };
    if (!body.plan) {
      return NextResponse.json({ error: "plan is required" }, { status: 400 });
    }

    const orgId = currentOrgId();
    const userId = currentUserId();
    const result = await commitAutoPlan(orgId, userId, body.plan);

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("commit error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
