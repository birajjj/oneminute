import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Kept under Vercel's ~4.5 MB request-body limit — the file bytes are stored in
// the DB, so this is meant for small documents, not large media.
const MAX_BYTES = 4 * 1024 * 1024;

// Upload a document against a meeting (multipart form field "file").
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const meeting = await db.meeting.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true }
    });
    if (!meeting) return NextResponse.json({ error: "meeting not found" }, { status: 404 });

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "no file" }, { status: 400 });
    }
    if (file.size === 0) return NextResponse.json({ error: "empty file" }, { status: 400 });
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "File too large (max 4 MB)" }, { status: 413 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const created = await db.attachment.create({
      data: {
        orgId: user.orgId,
        meetingId: id,
        fileName: (file.name || "document").slice(0, 200),
        contentType: file.type || "application/octet-stream",
        size: bytes.byteLength,
        data: bytes,
        uploadedById: user.id
      },
      select: { id: true, fileName: true }
    });
    return NextResponse.json({ ok: true, id: created.id, fileName: created.fileName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("attachment upload error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
