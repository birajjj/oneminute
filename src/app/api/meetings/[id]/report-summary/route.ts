import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateJson } from "@/lib/ai/provider";

export const runtime = "nodejs";

const TYPE_LABEL: Record<string, string> = {
  Note: "Note",
  Todo: "To-Do",
  Action: "Action",
  Devops: "Devops"
};

// Write a short, stakeholder-friendly executive summary of a meeting from its
// minutes, for the top of the report. Kept to 2-3 plain sentences.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const meeting = await db.meeting.findFirst({
      where: { id, orgId: user.orgId },
      select: {
        title: true,
        project: { select: { name: true } },
        minutes: { select: { title: true, description: true, type: true, tags: true } }
      }
    });
    if (!meeting) return NextResponse.json({ error: "meeting not found" }, { status: 404 });
    if (meeting.minutes.length === 0) return NextResponse.json({ summary: "" });

    const items = meeting.minutes
      .map((m) => {
        const t = TYPE_LABEL[m.type] ?? m.type;
        const flags = (m.tags ?? []).length ? ` [${m.tags.join(", ")}]` : "";
        return `- (${t})${flags} ${m.title}${m.description ? ": " + m.description : ""}`;
      })
      .join("\n");

    const prompt = [
      "You are writing a short executive summary of a meeting for EXTERNAL STAKEHOLDERS (clients).",
      `Meeting: "${meeting.title}" — project "${meeting.project.name}".`,
      "Write 2-3 plain-English sentences covering the key outcomes, decisions and next steps.",
      "Be clear and non-technical. No bullet points, no jargon, no internal login names.",
      "Only use what is in the notes below — do not invent anything.",
      "",
      "Minutes:",
      items
    ].join("\n");

    const { data } = await generateJson<{ summary: string }>({
      prompt,
      schema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"]
      },
      temperature: 0.4
    });

    return NextResponse.json({ summary: (data?.summary ?? "").trim() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("report summary error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
