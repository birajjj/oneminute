// Learns how THIS project's minutes are actually written, by reading the ones
// people have already committed.
//
// The output is a short paragraph of plain English, not an opaque model. That is
// the point: the person whose style it describes can read it, disagree, and edit
// it. It is then injected into the AI Recommendation prompt so suggestions arrive
// in their voice and at their level of detail, instead of a generic one.
//
// SERVER-ONLY.

import { db } from "@/lib/db";
import { generateJson } from "./provider";

const TYPE_LABEL: Record<string, string> = {
  Note: "Note",
  Todo: "To-Do",
  Action: "Action",
  Devops: "Devops"
};

// Enough meetings to show a pattern, few enough to keep the prompt affordable.
const MEETINGS_TO_READ = 10;
const MINUTES_PER_MEETING = 12;

const responseSchema = {
  type: "OBJECT",
  properties: { profile: { type: "STRING" } },
  required: ["profile"]
};

export interface LearnResult {
  profile: string;
  meetingsSeen: number;
}

export async function learnStyleProfile(
  orgId: string,
  projectId: string
): Promise<LearnResult | null> {
  const meetings = await db.meeting.findMany({
    where: { orgId, projectId },
    orderBy: { meetingDate: "desc" },
    take: MEETINGS_TO_READ,
    select: {
      title: true,
      description: true,
      minutes: {
        where: { parentMinuteId: null }, // the items themselves, not their updates
        orderBy: { createdAt: "asc" },
        take: MINUTES_PER_MEETING,
        select: { title: true, description: true, type: true, tags: true, area: true }
      }
    }
  });

  const withContent = meetings.filter((m) => m.minutes.length > 0);
  if (withContent.length === 0) return null;

  const lines: string[] = [];
  lines.push("Below are minutes a team has written for one project, across several meetings.");
  lines.push("");
  lines.push("Study them and describe HOW THIS TEAM WRITES MINUTES, so another writer could");
  lines.push("match them. Return `profile`: 120-200 words of plain English guidance.");
  lines.push("");
  lines.push("Cover what you can actually observe:");
  lines.push("- How long a description runs, and whether it explains reasoning or just states outcomes.");
  lines.push("- What they bother to record, and what they clearly leave out.");
  lines.push("- How they use the types: Note vs To-Do vs Action vs Devops.");
  lines.push("- How titles are phrased (imperative? noun phrase? length?).");
  lines.push("- What earns a Decision / Scope / Governance flag.");
  lines.push("- Any recurring subject matter or vocabulary worth knowing.");
  lines.push("");
  lines.push("IGNORE THE LAYOUT OF THE EXAMPLES. The \"- (Type [Flags]) Title\" form below is only");
  lines.push("how they are presented to you here — it is NOT part of how this team writes, and the");
  lines.push("system stores type and flags as separate fields. Never describe that formatting, and");
  lines.push("never tell the writer to prefix or bracket anything. Describe the CONTENT and the");
  lines.push("WORDING only.");
  lines.push("");
  lines.push("Write it as direct instructions to a writer (\"Describe the reasoning, not just the");
  lines.push("outcome\"), NOT as analysis (\"The team tends to...\"). Be specific to what you see —");
  lines.push("generic advice about good minute-taking is worthless here. Do not invent patterns");
  lines.push("from a single example.");
  lines.push("");

  for (const m of withContent) {
    lines.push(`### Meeting: ${m.title}`);
    if (m.description) lines.push(`Summary: ${m.description}`);
    for (const mn of m.minutes) {
      const flags = (mn.tags ?? []).length ? ` [${(mn.tags ?? []).join(", ")}]` : "";
      const type = TYPE_LABEL[mn.type] ?? mn.type;
      lines.push(`- (${type}${flags}) ${mn.title}`);
      if (mn.description) lines.push(`  ${mn.description}`);
    }
    lines.push("");
  }

  const { data } = await generateJson<{ profile: string }>({
    prompt: lines.join("\n"),
    schema: responseSchema,
    temperature: 0.3
  });

  const profile = (data?.profile ?? "").trim();
  if (!profile) return null;

  return { profile, meetingsSeen: withContent.length };
}

/** The stored profile for a project, or null. Used to shape suggestions. */
export async function getStyleProfile(orgId: string, projectId: string): Promise<string | null> {
  const row = await db.styleProfile.findFirst({
    where: { orgId, projectId },
    select: { profile: true }
  });
  return row?.profile?.trim() || null;
}
