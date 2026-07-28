import { NextRequest, NextResponse } from "next/server";
import { commitAutoPlan } from "@/lib/ai/auto-commit";
import type { AutoPlan } from "@/lib/ai/auto-plan";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { plan?: AutoPlan };
    if (!body.plan) {
      return NextResponse.json({ error: "plan is required" }, { status: 400 });
    }

    const user = await requireUser();
    const result = await commitAutoPlan(user.orgId, user.id, body.plan);

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("commit error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
