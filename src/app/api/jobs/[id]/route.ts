import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

// Status poll for the client. Returns progress, and the full result once done.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const job = await db.analysisJob.findUnique({ where: { id } });
    if (!job || job.orgId !== user.orgId) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({
      id: job.id,
      kind: job.kind,
      status: job.status,
      segmentsDone: job.segmentsDone,
      segmentsTotal: job.segmentsTotal,
      result: job.status === "done" ? job.result : null,
      error: job.error
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
