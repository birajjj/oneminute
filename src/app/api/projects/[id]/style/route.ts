import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { learnStyleProfile } from "@/lib/ai/style-profile";

export const runtime = "nodejs";
export const maxDuration = 60;

async function assertProject(id: string, orgId: string) {
  const project = await db.project.findFirst({ where: { id, orgId }, select: { id: true } });
  return !!project;
}

// The current profile, plus how stale it is.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    if (!(await assertProject(id, user.orgId))) {
      return NextResponse.json({ error: "project not found" }, { status: 404 });
    }

    const [row, meetingCount] = await Promise.all([
      db.styleProfile.findFirst({ where: { orgId: user.orgId, projectId: id } }),
      db.meeting.count({ where: { orgId: user.orgId, projectId: id } })
    ]);

    return NextResponse.json({
      profile: row?.profile ?? null,
      meetingsSeen: row?.meetingsSeen ?? 0,
      editedByHand: row?.editedByHand ?? false,
      updatedAt: row?.updatedAt ?? null,
      meetingCount
    });
  } catch (err) {
    return fail(err);
  }
}

// Learn (or re-learn) from the project's committed minutes.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    if (!(await assertProject(id, user.orgId))) {
      return NextResponse.json({ error: "project not found" }, { status: 404 });
    }

    const learned = await learnStyleProfile(user.orgId, id);
    if (!learned) {
      return NextResponse.json(
        { error: "Not enough minutes on this project to learn from yet." },
        { status: 400 }
      );
    }

    // Relearning replaces the text and clears the hand-edited mark, because the
    // stored prose is no longer what the person wrote.
    const saved = await db.styleProfile.upsert({
      where: { projectId: id },
      update: {
        profile: learned.profile,
        meetingsSeen: learned.meetingsSeen,
        editedByHand: false
      },
      create: {
        orgId: user.orgId,
        projectId: id,
        profile: learned.profile,
        meetingsSeen: learned.meetingsSeen
      }
    });

    return NextResponse.json({
      profile: saved.profile,
      meetingsSeen: saved.meetingsSeen,
      editedByHand: false
    });
  } catch (err) {
    return fail(err);
  }
}

// Hand-edit. The whole point of storing prose is that a person can correct it.
const PatchSchema = z.object({ profile: z.string().trim() });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = PatchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "profile is required" }, { status: 400 });
    }
    const user = await requireUser();
    if (!(await assertProject(id, user.orgId))) {
      return NextResponse.json({ error: "project not found" }, { status: 404 });
    }

    const saved = await db.styleProfile.upsert({
      where: { projectId: id },
      update: { profile: parsed.data.profile, editedByHand: true },
      create: {
        orgId: user.orgId,
        projectId: id,
        profile: parsed.data.profile,
        editedByHand: true
      }
    });
    return NextResponse.json({ profile: saved.profile, editedByHand: true });
  } catch (err) {
    return fail(err);
  }
}

function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : "unknown error";
  if (msg === "UNAUTHENTICATED") {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  console.error("style profile error:", msg);
  return NextResponse.json({ error: msg }, { status: 500 });
}
