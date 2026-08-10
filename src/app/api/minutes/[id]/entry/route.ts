import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import type { MinuteStatus, MinuteType } from "@prisma/client";

export const runtime = "nodejs";

const STATUS_MAP: Record<string, MinuteStatus> = {
  New: "New",
  Initiated: "Initiated",
  "In Progress": "InProgress",
  Resolved: "Resolved",
  Closed: "Completed",
  Completed: "Completed",
  Cancelled: "Cancelled"
};
const TYPE_MAP: Record<string, MinuteType> = {
  Note: "Note",
  "To-Do": "Todo",
  Action: "Action",
  Devops: "Devops"
};

// Adds a follow-up entry to an item's thread, inside a given meeting — used by
// Browse's "Mark As Complete" on a follow-up item (records the completion as a
// new entry, and advances the item's live status). [id] is the thread root.
const BodySchema = z.object({
  meetingId: z.string().min(1),
  status: z.string().optional(),
  note: z.string().optional(),
  type: z.string().optional()
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid body" }, { status: 400 });
    }
    const user = await requireUser();

    const root = await db.minute.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true, area: true, title: true, type: true, status: true }
    });
    if (!root) return NextResponse.json({ error: "item not found" }, { status: 404 });

    const meeting = await db.meeting.findFirst({
      where: { id: parsed.data.meetingId, orgId: user.orgId },
      select: { id: true }
    });
    if (!meeting) return NextResponse.json({ error: "meeting not found" }, { status: 404 });

    const newStatus = parsed.data.status ? STATUS_MAP[parsed.data.status] : undefined;

    await db.minute.create({
      data: {
        orgId: user.orgId,
        meetingId: meeting.id,
        area: root.area || "General",
        title: root.title,
        description: parsed.data.note?.trim() || null,
        type: parsed.data.type ? TYPE_MAP[parsed.data.type] ?? root.type : root.type,
        status: newStatus ?? root.status,
        parentMinuteId: root.id,
        isPersistent: false
      }
    });

    // Point-in-time: the entry carries its own status; we don't overwrite the
    // item's status here (current status is derived from the latest entry).
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("minute entry error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
