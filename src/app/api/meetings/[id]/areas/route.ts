import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Rename an area/tab (e.g. when the AI picked a poor name). Renaming applies to
// the WHOLE PROJECT, not just this meeting: an area is an organising label that
// recurs across a project's meetings, threads span meetings and must share one
// area name, and the AI reuses a project's existing area names. Renaming per
// meeting would fragment a thread across differently-named tabs.
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
      select: { id: true, projectId: true }
    });
    if (!meeting) return NextResponse.json({ error: "meeting not found" }, { status: 404 });

    const from = parsed.data.from.trim();
    const to = parsed.data.to.trim();
    if (!to) return NextResponse.json({ error: "invalid name" }, { status: 400 });
    if (from === to) return NextResponse.json({ ok: true });

    // Resolve the project's meetings up front and filter on scalar meetingId —
    // updateMany/deleteMany don't reliably honour relation filters in Prisma.
    const projectMeetings = await db.meeting.findMany({
      where: { orgId: user.orgId, projectId: meeting.projectId },
      select: { id: true }
    });
    const meetingIds = projectMeetings.map((m) => m.id);
    if (meetingIds.length === 0) return NextResponse.json({ ok: true });

    // Re-file every minute in the project that sits under the old name.
    const moved = await db.minute.updateMany({
      where: { orgId: user.orgId, meetingId: { in: meetingIds }, area: from },
      data: { area: to }
    });

    // Rename the tab on each meeting — but where a meeting already has a tab of
    // the target name, drop the old one instead so the two merge cleanly.
    const withTarget = await db.meetingArea.findMany({
      where: { orgId: user.orgId, meetingId: { in: meetingIds }, areaName: to },
      select: { meetingId: true }
    });
    const targetIds = new Set(withTarget.map((m) => m.meetingId));
    const toRename = meetingIds.filter((id) => !targetIds.has(id));

    if (targetIds.size > 0) {
      await db.meetingArea.deleteMany({
        where: {
          orgId: user.orgId,
          meetingId: { in: [...targetIds] },
          areaName: from
        }
      });
    }
    if (toRename.length > 0) {
      await db.meetingArea.updateMany({
        where: { orgId: user.orgId, meetingId: { in: toRename }, areaName: from },
        data: { areaName: to }
      });
    }

    return NextResponse.json({ ok: true, minutesMoved: moved.count });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("area rename error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
