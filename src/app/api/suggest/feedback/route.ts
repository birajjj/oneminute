import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Records what happened to a suggestion. Declines are the point: they teach the
// system what this project does not consider worth minuting, which nothing in
// the transcript can reveal.
const BodySchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1),
  minuteType: z.string().default("Note"),
  accepted: z.boolean()
});

export async function POST(req: NextRequest) {
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid body" }, { status: 400 });
    }
    const user = await requireUser();

    // Scoped to the caller's org so feedback can't be written against another's project.
    const project = await db.project.findFirst({
      where: { id: parsed.data.projectId, orgId: user.orgId },
      select: { id: true }
    });
    if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

    await db.suggestionFeedback.create({
      data: {
        orgId: user.orgId,
        projectId: project.id,
        title: parsed.data.title,
        minuteType: parsed.data.minuteType,
        accepted: parsed.data.accepted
      }
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("suggestion feedback error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
