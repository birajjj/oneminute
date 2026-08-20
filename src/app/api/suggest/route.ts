import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { suggestMissing } from "@/lib/ai/suggest";
import { getStyleProfile } from "@/lib/ai/style-profile";

export const runtime = "nodejs";
export const maxDuration = 60;

// Reviews ONE chunk of the transcript against the minutes written so far and
// returns what looks missing. The client splits a long transcript and calls this
// sequentially (same pattern as analyze-chunk), so each call stays under the 60s
// cap. Read-only — nothing is saved; the user chooses what to accept.
const BodySchema = z.object({
  chunk: z.string().min(1),
  captured: z
    .array(
      z.object({
        title: z.string().default(""),
        description: z.string().default(""),
        type: z.string().default("Note")
      })
    )
    .default([]),
  areas: z.array(z.string()).optional(),
  // Which project's house style to apply. Optional — without it the check still
  // works, just without the learned voice.
  projectId: z.string().optional()
});

export async function POST(req: NextRequest) {
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "chunk is required" }, { status: 400 });
    }
    const user = await requireUser();

    // Scoped to the caller's org, so a project id from elsewhere reveals nothing.
    const styleProfile = parsed.data.projectId
      ? await getStyleProfile(user.orgId, parsed.data.projectId)
      : null;

    const suggestions = await suggestMissing(parsed.data.chunk, parsed.data.captured, {
      areas: parsed.data.areas,
      styleProfile
    });
    return NextResponse.json({ suggestions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("suggest error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
