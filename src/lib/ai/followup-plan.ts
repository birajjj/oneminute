// Follow-up AI pre-fill. Unlike Auto Mode (which decides everything from
// scratch), this is handed the EXACT open items to review, so its job is narrow
// and reliable: for each open item, did the meeting discuss it and what's the
// update — plus any brand-new items raised. Uses the shared provider dispatcher
// (Claude when AI_PROVIDER=anthropic, else Gemini).
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

const responseSchema = {
  type: "OBJECT",
  properties: {
    updates: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          rootMinuteId: { type: "STRING" },
          discussed: { type: "BOOLEAN" },
          note: { type: "STRING" },
          status: { type: "STRING" }
        },
        required: ["rootMinuteId", "discussed"]
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
  const { data } = await generateJson<FollowUpPlan>({
    prompt,
    schema: responseSchema,
    temperature: 0.3
  });

  if (!data) return { updates: [], newMinutes: [], summary: "" };

  const validIds = new Set(openItems.map((i) => i.id));
  const updates = (data.updates || [])
    .filter((u) => validIds.has(u.rootMinuteId))
    .map((u) => ({
      rootMinuteId: u.rootMinuteId,
      discussed: !!u.discussed,
      note: u.note || "",
      status: normalizeStatus(u.status)
    }));

  const newMinutes = (data.newMinutes || [])
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
    "Below are the OPEN action items carried forward from earlier meetings, each with an id."
  );
  lines.push("Read the transcript and, for EACH open item, decide:");
  lines.push("- discussed: was this specific item discussed in this meeting? (true/false)");
  lines.push("- note: a ONE-sentence update of what was said about it (empty if not discussed).");
  lines.push(
    "- status: the item's status after this meeting — one of New, Initiated, In Progress, Completed, Cancelled. Keep the current status if unchanged or not discussed."
  );
  lines.push("Also capture anything raised for the FIRST time as newMinutes.");
  lines.push("");
  lines.push("### RULES");
  lines.push("- Only use rootMinuteId values from the list below; never invent ids.");
  lines.push("- If an item was not mentioned, set discussed=false and keep its current status.");
  lines.push("- Mark status Completed only when the transcript clearly says it is done/finished.");
  lines.push("- newMinutes.minuteType is one of: Note, To-Do, Action, Devops.");
  lines.push("- assignedTo must exactly match an allowed user, or be empty.");
  lines.push("");
  lines.push(`Allowed users: [${users.join(", ")}]`);
  lines.push("");
  lines.push("### Open items");
  if (openItems.length === 0) {
    lines.push("(none)");
  } else {
    for (const it of openItems) {
      const who = it.assignedTo ? `, assignee ${it.assignedTo}` : "";
      lines.push(
        `- rootMinuteId=${it.id} [${it.status}] ${it.type}: ${it.title} (area ${it.area}${who})`
      );
    }
  }
  lines.push("");
  lines.push("### Transcript");
  lines.push(transcript);

  return lines.join("\n");
}
