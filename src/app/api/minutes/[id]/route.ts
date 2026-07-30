import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import type { MinuteStatus } from "@prisma/client";

export const runtime = "nodejs";

const STATUS_MAP: Record<string, MinuteStatus> = {
  New: "New",
  Initiated: "Initiated",
  "In Progress": "InProgress",
  Completed: "Completed",
  Cancelled: "Cancelled"
};

// Inline edits from Browse. status is a label ("In Progress"); assignedTo is a
// display name ("" = unassign). Both optional — send only what changed.
const BodySchema = z.object({
  status: z.string().optional(),
  assignedTo: z.string().optional()
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
      select: { id: true }
    });
    if (!minute) return NextResponse.json({ error: "not found" }, { status: 404 });

    const data: { status?: MinuteStatus; assignedToUserId?: string | null } = {};

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

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    await db.minute.update({ where: { id }, data });
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
