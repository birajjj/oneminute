import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Serve an attachment's bytes for viewing/download (org-scoped).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const att = await db.attachment.findFirst({
      where: { id, orgId: user.orgId },
      select: { fileName: true, contentType: true, size: true, data: true }
    });
    if (!att) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Strip quotes from the filename so it can't break the header.
    const safeName = att.fileName.replace(/["\\\r\n]/g, "");
    return new NextResponse(att.data, {
      headers: {
        "Content-Type": att.contentType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(att.fileName)}`,
        "Content-Length": String(att.size),
        "Cache-Control": "private, no-store"
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("attachment fetch error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Remove an attachment.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const att = await db.attachment.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true }
    });
    if (!att) return NextResponse.json({ error: "not found" }, { status: 404 });
    await db.attachment.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("attachment delete error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
