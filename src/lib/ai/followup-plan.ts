// Follow-up AI pre-fill. Unlike Auto Mode (which decides everything from
// scratch), this is handed the EXACT open items to review, so its job is narrow
// and reliable: for each open item, did the meeting discuss it and what's the
// update — plus any brand-new items raised. Uses the shared provider dispatcher
// (Claude when AI_PROVIDER=anthropic, else Gemini).
//
// The AI references items by a short 1-based `ref` number, NOT their UUID —
// models copy small integers reliably but mangle long UUIDs. We map ref -> id
// server-side, so the caller still gets real rootMinuteIds.
//
// SERVER-ONLY.

import { generateJson } from "./provider";
import type { OpenItem } from "@/lib/followup";

const TYPE_VALUES = ["Note", "To-Do", "Action", "Devops"] as const;
const STATUS_VALUES = ["New", "Initiated", "In Progress", "Completed", "Cancelled"] as const;

export interface FollowUpUpdate {
  rootMinuteId: string;
  discussed: boolean;
  note: string;
  status: string; // label
}

export interface FollowUpNewMinute {
  area: string;
  title: string;
  description: string;
  minuteType: string;
  status: string;
  assignedTo: string;
}

export interface FollowUpPlan {
  updates: FollowUpUpdate[];
  newMinutes: FollowUpNewMinute[];
  summary: string;
}

// Shape the AI returns (ref-based).
interface RawPlan {
  updates?: { ref: number; discussed: boolean; note: string; status: string }[];
  newMinutes?: {
    area: string;
    title: string;
    description: string;
    minuteType: string;
    status: string;
    assignedTo: string;
  }[];
  summary?: string;
}

const responseSchema = {
  type: "OBJECT",
  properties: {
    updates: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          ref: { type: "INTEGER" },
          discussed: { type: "BOOLEAN" },
          note: { type: "STRING" },
          status: { type: "STRING" }
        },
        required: ["ref", "discussed"]
      }
    },
    newMinutes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          area: { type: "STRING" },
          title: { type: "STRING" },
          description: { type: "STRING" },
          minuteType: { type: "STRING" },
          status: { type: "STRING" },
          assignedTo: { type: "STRING" }
        },
        required: ["title"]
      }
    },
    summary: { type: "STRING" }
  },
  required: ["updates"]
};

export async function buildFollowUpPlan(
  openItems: OpenItem[],
  users: string[],
  transcript: string
): Promise<FollowUpPlan> {
  const prompt = buildPrompt(openItems, users, transcript);
  const { data } = await generateJson<RawPlan>({
    prompt,
    schema: responseSchema,
    temperature: 0.3
  });

  if (!data) return { updates: [], newMinutes: [], summary: "" };

  // Map each ref (1-based) back to the real open-item id.
  const updates: FollowUpUpdate[] = [];
  for (const u of data.updates || []) {
    const idx = Number(u.ref) - 1;
    const item = openItems[idx];
    if (!item) continue;
    updates.push({
      rootMinuteId: item.id,
      discussed: !!u.discussed,
      note: u.note || "",
      status: normalizeStatus(u.status)
    });
  }

  const newMinutes: FollowUpNewMinute[] = (data.newMinutes || [])
    .filter((m) => m.title && m.title.trim())
    .map((m) => ({
      area: m.area || "General",
      title: m.title,
      description: m.description || "",
      minuteType: normalizeType(m.minuteType),
      status: normalizeStatus(m.status) || "New",
      assignedTo: m.assignedTo || ""
    }));

  return { updates, newMinutes, summary: data.summary || "" };
}

function normalizeStatus(s: string | undefined): string {
  return s && (STATUS_VALUES as readonly string[]).includes(s) ? s : "";
}
function normalizeType(t: string | undefined): string {
  return t && (TYPE_VALUES as readonly string[]).includes(t) ? t : "Note";
}

function buildPrompt(openItems: OpenItem[], users: string[], transcript: string): string {
  const lines: string[] = [];
  lines.push("You are updating a FOLLOW-UP meeting's minutes.");
  lines.push(
    "Below are the OPEN action items carried forward from earlier meetings, each with a ref number."
  );
  lines.push("Read the transcript and do BOTH tasks below. Both are equally important.");
  lines.push("");
  lines.push("TASK 1 — Update every open item. Return `updates` with EXACTLY ONE entry per open item:");
  lines.push("- ref: the item's ref number below (1-based). Copy it exactly.");
  lines.push("- discussed: was this specific item discussed this meeting? (true/false)");
  lines.push("- note: a ONE-sentence update of what was said (empty string if not discussed).");
  lines.push("- status: New | Initiated | In Progress | Completed | Cancelled. Keep the current status if unchanged or not discussed; use Completed only when the transcript clearly says it is done.");
  lines.push("");
  lines.push("TASK 2 — Capture NEW items. Return `newMinutes` with EVERY new to-do, action, decision,");
  lines.push("or note raised this meeting that is NOT one of the open items above. Whenever a new task is");
  lines.push("mentioned (e.g. \"let's set up X\", \"we need to do Y\", \"raise a bug for Z\", \"assign someone to W\"),");
  lines.push("it MUST appear here. Each entry: title, description, minuteType (Note | To-Do | Action | Devops),");
  lines.push("status, assignedTo. Return an empty array only if genuinely nothing new was raised.");
  lines.push("");
  lines.push("Rules: assignedTo must exactly match an allowed user or be an empty string.");
  lines.push(`Allowed users: [${users.join(", ")}]`);
  lines.push("");
  lines.push("### Open items");
  if (openItems.length === 0) {
    lines.push("(none)");
  } else {
    openItems.forEach((it, i) => {
      const who = it.assignedTo ? `, assignee ${it.assignedTo}` : "";
      lines.push(
        `- ref=${i + 1} [${it.status}] ${it.type}: ${it.title} (area ${it.area}${who})`
      );
    });
  }
  lines.push("");
  lines.push("### Transcript");
  lines.push(transcript);

  return lines.join("\n");
}
