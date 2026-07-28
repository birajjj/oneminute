import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildAutoPlan } from "@/lib/ai/auto-plan";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  transcript: z.string().min(1)
});

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "transcript is required" }, { status: 400 });
    }

    const user = await requireUser();
    const plan = await buildAutoPlan(user.orgId, parsed.data.transcript);

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
