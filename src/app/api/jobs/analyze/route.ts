import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createAnalysisJob, triggerStep, selfOrigin } from "@/lib/jobs/analysis";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  kind: z.enum(["auto", "followup"]),
  transcript: z.string().min(1),
  // Auto: caller's local date so meetings default to the user's day.
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Follow-up: the meeting being followed up.
  parentMeetingId: z.string().optional()
});

export async function POST(req: NextRequest) {
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid body" }, { status: 400 });
    }
    const { kind, transcript, today, parentMeetingId } = parsed.data;
    if (kind === "followup" && !parentMeetingId) {
      return NextResponse.json({ error: "parentMeetingId required" }, { status: 400 });
    }

    const user = await requireUser();
    const params = kind === "auto" ? { today } : { parentMeetingId };
    const job = await createAnalysisJob({
      orgId: user.orgId,
      userId: user.id,
      kind,
      transcript,
      params
    });

    // Kick the first segment server-side; each step re-triggers the next, so the
    // job runs to completion even if the user closes the tab.
    const origin = selfOrigin(req);
    after(async () => {
      await triggerStep(origin, job.id, job.runToken);
    });

    return NextResponse.json({ jobId: job.id, segmentsTotal: job.segmentsTotal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("job create error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
