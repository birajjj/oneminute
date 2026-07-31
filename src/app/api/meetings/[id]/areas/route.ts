import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Rename an area/tab within a meeting (e.g. when the AI picked a poor name).
// Renames the MeetingArea row and re-files every minute in that meeting that
// currently sits under the old name.
const BodySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1)
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "from and to are required" }, { status: 400 });
    }

    const user = await requireUser();
    const meeting = await db.meeting.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true }
    });
    if (!meeting) return NextResponse.json({ error: "meeting not found" }, { status: 404 });

    const from = parsed.data.from.trim();
    const to = parsed.data.to.trim();
    if (!to) return NextResponse.json({ error: "invalid name" }, { status: 400 });
    if (from === to) return NextResponse.json({ ok: true });

    await db.minute.updateMany({
      where: { orgId: user.orgId, meetingId: meeting.id, area: from },
      data: { area: to }
    });

    // Merge into an existing tab of that name if there is one, else rename.
    const target = await db.meetingArea.findFirst({
      where: { orgId: user.orgId, meetingId: meeting.id, areaName: to },
      select: { id: true }
    });
    if (target) {
      await db.meetingArea.deleteMany({
        where: { orgId: user.orgId, meetingId: meeting.id, areaName: from }
      });
    } else {
      await db.meetingArea.updateMany({
        where: { orgId: user.orgId, meetingId: meeting.id, areaName: from },
        data: { areaName: to }
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("area rename error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
