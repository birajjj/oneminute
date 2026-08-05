import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Delete a project and everything under it. Meetings → minutes → areas cascade
 * (onDelete: Cascade). Minutes also reference each other (follow-up threads,
 * raised sub-items); those self-links are cleared first so the cascade can't hit
 * a foreign-key error. Irreversible — audit-logged with the counts removed.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();

    const project = await db.project.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true, name: true }
    });
    if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

    const meetingIds = (
      await db.meeting.findMany({
        where: { orgId: user.orgId, projectId: id },
        select: { id: true }
      })
    ).map((m) => m.id);
    const minuteCount = meetingIds.length
      ? await db.minute.count({ where: { orgId: user.orgId, meetingId: { in: meetingIds } } })
      : 0;

    await db.$transaction(
      async (tx) => {
        // Break minute→minute links so cascading the meetings can't be blocked.
        if (meetingIds.length > 0) {
          await tx.minute.updateMany({
            where: { orgId: user.orgId, meetingId: { in: meetingIds } },
            data: { parentMinuteId: null, raisedFromRootId: null }
          });
        }
        await tx.project.delete({ where: { id } });
      },
      { maxWait: 15000, timeout: 60000 }
    );

    await db.auditLog.create({
      data: {
        orgId: user.orgId,
        userId: user.id,
        action: "delete_project",
        tableName: "projects",
        rowId: id,
        before: { name: project.name, meetings: meetingIds.length, minutes: minuteCount }
      }
    });

    return NextResponse.json({ ok: true, meetings: meetingIds.length, minutes: minuteCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("project delete error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
