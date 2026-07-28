import { NextRequest, NextResponse } from "next/server";
import { transcribeAudio } from "@/lib/ai/gemini";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("audio");

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: "audio file is required" }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const mime = file.type || "audio/webm";
    const transcript = await transcribeAudio(bytes, mime);

    return NextResponse.json({ transcript });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("transcribe error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
