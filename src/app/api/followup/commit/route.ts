import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { commitFollowUp } from "@/lib/followup-commit";

export const runtime = "nodejs";
export const maxDuration = 60;

const NewMinuteSchema = z.object({
  area: z.string(),
  title: z.string(),
  description: z.string(),
  type: z.string(),
  status: z.string(),
  assignedTo: z.string(),
  dueDate: z.string(),
  tags: z.array(z.string()).default([]),
  devopsAction: z.string(),
  devopsProject: z.string(),
  devopsWorkItemType: z.string(),
  devopsWorkItemId: z.string()
});

const BodySchema = z.object({
  parentMeetingId: z.string().min(1),
  meetingTitle: z.string().min(1),
  meetingDate: z.string(),
  summary: z.string().optional().default(""),
  transcript: z.string().optional().default(""),
  updates: z.array(
    z.object({
      rootMinuteId: z.string(),
      noUpdate: z.boolean(),
      type: z.string(),
      status: z.string(),
      note: z.string(),
      assignedTo: z.string(),
      dueDate: z.string(),
      tags: z.array(z.string()).default([]),
      devopsAction: z.string(),
      devopsProject: z.string(),
      devopsWorkItemType: z.string(),
      devopsWorkItemId: z.string(),
      subEntries: z.array(NewMinuteSchema).default([])
    })
  ),
  newMinutes: z.array(
    NewMinuteSchema.extend({ children: z.array(NewMinuteSchema).default([]) })
  )
});

export async function POST(req: NextRequest) {
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid request body" }, { status: 400 });
    }

    const user = await requireUser();
    const result = await commitFollowUp(user.orgId, user.id, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("followup commit error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
