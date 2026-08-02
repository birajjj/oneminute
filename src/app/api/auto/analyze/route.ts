import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildAutoPlan } from "@/lib/ai/auto-plan";
import { requireUser } from "@/lib/auth";

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
    const plan = await buildAutoPlan(user.orgId, parsed.data.transcript, parsed.data.today);

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
