import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Stakeholders are project-scoped: the recipient list for a project's meeting
// reports. GET lists them; POST adds one (idempotent on project+email).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const project = await db.project.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true }
    });
    if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

    const stakeholders = await db.stakeholder.findMany({
      where: { projectId: id, orgId: user.orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true }
    });
    return NextResponse.json({ stakeholders });
  } catch (err) {
    return errorResponse(err);
  }
}

const BodySchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email()
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "name and a valid email are required" }, { status: 400 });
    }
    const user = await requireUser();
    const project = await db.project.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true }
    });
    if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

    const email = parsed.data.email.toLowerCase();
    const stakeholder = await db.stakeholder.upsert({
      where: { projectId_email: { projectId: id, email } },
      update: { name: parsed.data.name },
      create: { orgId: user.orgId, projectId: id, name: parsed.data.name, email },
      select: { id: true, name: true, email: true }
    });
    return NextResponse.json({ stakeholder });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  const msg = err instanceof Error ? err.message : "unknown error";
  if (msg === "UNAUTHENTICATED") {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  console.error("stakeholders error:", msg);
  return NextResponse.json({ error: msg }, { status: 500 });
}
