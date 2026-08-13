import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateJson } from "@/lib/ai/provider";
import { loadProjectItems } from "@/lib/project-report";

export const runtime = "nodejs";

// A short, stakeholder-friendly summary of where a whole project stands.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const project = await db.project.findFirst({
      where: { id, orgId: user.orgId },
      select: { name: true }
    });
    if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

    const items = await loadProjectItems(user.orgId, id);
    if (items.length === 0) return NextResponse.json({ summary: "" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isOpen = (s: string) => s !== "Closed" && s !== "Cancelled";
    const lines = items
      .map((it) => {
        const overdue =
          it.dueDate && isOpen(it.status) && new Date(it.dueDate) < today ? " [OVERDUE]" : "";
        const flags = it.tags.length ? ` [${it.tags.join(", ")}]` : "";
        return `- (${it.type}, ${it.status})${overdue}${flags} ${it.title}`;
      })
      .join("\n");

    const prompt = [
      "You are writing a short PROJECT STATUS update for external stakeholders.",
      `Project: "${project.name}".`,
      "In 2-3 plain-English sentences, summarise where the project stands overall: progress",
      "so far, what is on track, any overdue or at-risk items, and key decisions. Non-technical,",
      "no jargon, no internal login names. Only use what is listed below — do not invent anything.",
      "",
      "Items (type, current status):",
      lines
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
    console.error("project report summary error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
