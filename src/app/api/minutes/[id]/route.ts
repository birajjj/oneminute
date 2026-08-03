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
  Completed: "Completed",
  Cancelled: "Cancelled"
};

const TYPE_MAP: Record<string, MinuteType> = {
  Note: "Note",
  "To-Do": "Todo",
  Action: "Action",
  Devops: "Devops"
};

// Inline edits from Browse. status is a label ("In Progress"); assignedTo is a
// display name ("" = unassign); description is the minute text. All optional —
// send only what changed.
const BodySchema = z.object({
  status: z.string().optional(),
  assignedTo: z.string().optional(),
  description: z.string().optional(),
  title: z.string().optional(),
  // Re-file into another area/tab. Applies to the whole thread so an item's
  // updates don't scatter across tabs.
  area: z.string().optional(),
  // Governance flags — the full desired set, not a delta.
  tags: z.array(z.string()).optional(),
  // Item type (label). Belongs to the item's identity, so it's applied to the
  // thread ROOT, not just this entry.
  type: z.string().optional()
});

export async function PATCH(
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

    // Only edit minutes in the caller's org.
    const minute = await db.minute.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true, parentMinuteId: true, meetingId: true }
    });
    if (!minute) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Moving to another area moves the WHOLE thread (root + every follow-up),
    // so an item and its updates stay together under one tab.
    if (parsed.data.area !== undefined) {
      const area = parsed.data.area.trim() || "General";
      const rootId = minute.parentMinuteId ?? minute.id;
      await db.minute.updateMany({
        where: { orgId: user.orgId, OR: [{ id: rootId }, { parentMinuteId: rootId }] },
        data: { area }
      });
      // Make sure the destination tab exists on this minute's meeting.
      const exists = await db.meetingArea.findFirst({
        where: { orgId: user.orgId, meetingId: minute.meetingId, areaName: area },
        select: { id: true }
      });
      if (!exists) {
        await db.meetingArea.create({
          data: { orgId: user.orgId, meetingId: minute.meetingId, areaName: area }
        });
      }
    }

    // Type is the item's identity → set it on the thread root.
    if (parsed.data.type !== undefined) {
      const mapped = TYPE_MAP[parsed.data.type];
      if (mapped) {
        const rootId = minute.parentMinuteId ?? minute.id;
        await db.minute.update({ where: { id: rootId }, data: { type: mapped } });
      }
    }

    const data: {
      status?: MinuteStatus;
      assignedToUserId?: string | null;
      description?: string | null;
      title?: string;
      tags?: string[];
    } = {};

    if (parsed.data.tags !== undefined) {
      data.tags = normalizeTags(parsed.data.tags);
    }

    if (parsed.data.title !== undefined) {
      const t = parsed.data.title.trim();
      if (t) data.title = t; // never blank out a title
    }

    if (parsed.data.description !== undefined) {
      data.description = parsed.data.description.trim() || null;
    }

    if (parsed.data.status !== undefined) {
      const mapped = STATUS_MAP[parsed.data.status];
      if (!mapped) return NextResponse.json({ error: "invalid status" }, { status: 400 });
      data.status = mapped;
    }

    if (parsed.data.assignedTo !== undefined) {
      const name = parsed.data.assignedTo.trim();
      if (!name) {
        data.assignedToUserId = null;
      } else {
        const u = await db.user.findFirst({
          where: { orgId: user.orgId, displayName: name },
          select: { id: true }
        });
        data.assignedToUserId = u?.id ?? null;
      }
    }

    // An area-only move is already applied above; other fields update this minute.
    if (Object.keys(data).length > 0) {
      await db.minute.update({ where: { id }, data });
    } else if (parsed.data.area === undefined) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("minute update error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
