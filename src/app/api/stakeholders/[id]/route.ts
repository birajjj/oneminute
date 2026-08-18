import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Remove a stakeholder from a project's recipient list. Org-scoped so one org
// can never delete another's row.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const existing = await db.stakeholder.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true }
    });
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

    await db.stakeholder.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("stakeholder delete error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
