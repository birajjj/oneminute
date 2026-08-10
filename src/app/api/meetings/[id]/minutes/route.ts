import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import type { MinuteStatus, MinuteType } from "@prisma/client";
import { normalizeTags } from "@/lib/tags";

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

// Add a minute by hand to an already-committed meeting, straight from Browse —
// the same "+ Add minute" the follow-up page has, but this one writes to the DB
// now (the meeting isn't a draft). A To-Do/Action/Devops is persistent so it
// carries into follow-ups; a plain Note is not. Labels come from the client.
const BodySchema = z.object({
  area: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  assignedTo: z.string().optional(),
  dueDate: z.string().optional(),
  tags: z.array(z.string()).optional()
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    const user = await requireUser();
    const meeting = await db.meeting.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true }
    });
    if (!meeting) return NextResponse.json({ error: "meeting not found" }, { status: 404 });

    const b = parsed.data;
    const title = b.title.trim();
    if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });

    const area = (b.area ?? "").trim() || "General";
    const typeLabel = b.type ?? "Note";
    const type = TYPE_MAP[typeLabel] ?? "Note";
    const status = STATUS_MAP[b.status ?? "New"] ?? "New";

    // Resolve an assignee display name to a roster user (blank = unassigned).
    let assignedToUserId: string | null = null;
    const assignee = (b.assignedTo ?? "").trim();
    if (assignee) {
      const u = await db.user.findFirst({
        where: { orgId: user.orgId, displayName: assignee },
        select: { id: true }
      });
      assignedToUserId = u?.id ?? null;
    }

    let dueDate: Date | null = null;
    if (b.dueDate) {
      const d = new Date(b.dueDate);
      if (!Number.isNaN(d.getTime())) dueDate = d;
    }

    const created = await db.minute.create({
      data: {
        orgId: user.orgId,
        meetingId: id,
        area,
        title,
        description: b.description?.trim() || null,
        type,
        status,
        isPersistent: ["To-Do", "Action", "Devops"].includes(typeLabel),
        tags: normalizeTags(b.tags ?? []),
        assignedToUserId,
        dueDate,
        createdOnFly: true
      },
      select: { id: true }
    });

    // Make sure the tab exists on this meeting (so an added minute's area shows
    // even if the tab was empty until now). Idempotent.
    await db.meetingArea.upsert({
      where: { meetingId_areaName: { meetingId: id, areaName: area } },
      update: {},
      create: { orgId: user.orgId, meetingId: id, areaName: area, createdOnFly: true }
    });

    return NextResponse.json({ ok: true, id: created.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("minute create error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
