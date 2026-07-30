import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Inline edits to a meeting's details from Browse. All optional.
const BodySchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  attendee: z.string().optional()
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

    const meeting = await db.meeting.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true }
    });
    if (!meeting) return NextResponse.json({ error: "not found" }, { status: 404 });

    const data: { title?: string; description?: string | null; attendee?: string | null } = {};

    if (parsed.data.title !== undefined) {
      const t = parsed.data.title.trim();
      if (t) data.title = t; // never blank out a meeting title
    }
    if (parsed.data.description !== undefined) {
      data.description = parsed.data.description.trim() || null;
    }
    if (parsed.data.attendee !== undefined) {
      data.attendee = parsed.data.attendee.trim() || null;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    await db.meeting.update({ where: { id }, data });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("meeting update error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
