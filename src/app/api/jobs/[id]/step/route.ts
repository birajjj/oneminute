import { NextRequest, NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { claimJob, runNextSegment, triggerStep } from "@/lib/jobs/analysis";

export const runtime = "nodejs";
export const maxDuration = 60;

// Processes ONE transcript segment for a job, then re-triggers itself for the
// next until finished. Callable two ways:
//   - by the self-trigger chain, authenticated with the job's runToken header;
//   - by a signed-in user of the same org (the client uses this to nudge a
//     stalled job it's polling).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const job = await db.analysisJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Authorize.
    const token = req.headers.get("x-run-token");
    let authorized = !!token && token === job.runToken;
    if (!authorized) {
      try {
        const user = await requireUser();
        authorized = user.orgId === job.orgId;
      } catch {
        /* fall through to 401 */
      }
    }
    if (!authorized) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    if (job.status === "done" || job.status === "error") {
      return NextResponse.json({
        status: job.status,
        segmentsDone: job.segmentsDone,
        segmentsTotal: job.segmentsTotal
      });
    }

    const claimed = await claimJob(id);
    if (!claimed) {
      // Someone else holds a fresh lock — that worker will advance it.
      return NextResponse.json({ status: "running", locked: true });
    }

    let outcome;
    try {
      outcome = await runNextSegment(claimed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "analysis failed";
      return NextResponse.json({ status: "error", error: msg }, { status: 500 });
    }

    if (!outcome.done) {
      const origin = new URL(req.url).origin;
      after(async () => {
        await triggerStep(origin, id, job.runToken);
      });
    }

    return NextResponse.json({
      status: outcome.done ? "done" : "running",
      segmentsDone: outcome.segmentsDone,
      segmentsTotal: outcome.segmentsTotal
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("job step error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
