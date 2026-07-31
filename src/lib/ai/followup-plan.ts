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

export interface DevopsSuggestion {
  devopsAction: string; // "none" | "create" | "link"
  devopsWorkItemType: string; // "User Story" | "Bug"
  devopsWorkItemId: string; // for link
}

export interface FollowUpUpdate extends DevopsSuggestion {
  rootMinuteId: string;
  discussed: boolean;
  note: string;
  status: string; // label
}

export interface FollowUpNewMinute extends DevopsSuggestion {
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
interface RawDevops {
  devopsAction?: string;
  devopsWorkItemType?: string;
  devopsWorkItemId?: string;
}
interface RawPlan {
  updates?: ({ ref: number; discussed: boolean; note: string; status: string } & RawDevops)[];
  newMinutes?: ({
    area: string;
    title: string;
    description: string;
    minuteType: string;
    status: string;
    assignedTo: string;
  } & RawDevops)[];
  summary?: string;
}

const devopsSchemaProps = {
  devopsAction: { type: "STRING" }, // none | create | link
  devopsWorkItemType: { type: "STRING" }, // User Story | Bug
  devopsWorkItemId: { type: "STRING" } // for link
};

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
          status: { type: "STRING" },
          ...devopsSchemaProps
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
          assignedTo: { type: "STRING" },
          ...devopsSchemaProps
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
      status: normalizeStatus(u.status),
      devopsAction: normalizeDevopsAction(u.devopsAction),
      devopsWorkItemType: normalizeWorkItemType(u.devopsWorkItemType),
      devopsWorkItemId: u.devopsWorkItemId || ""
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
      assignedTo: m.assignedTo || "",
      devopsAction: normalizeDevopsAction(m.devopsAction),
      devopsWorkItemType: normalizeWorkItemType(m.devopsWorkItemType),
      devopsWorkItemId: m.devopsWorkItemId || ""
    }));

  return { updates, newMinutes, summary: data.summary || "" };
}

function normalizeStatus(s: string | undefined): string {
  return s && (STATUS_VALUES as readonly string[]).includes(s) ? s : "";
}
function normalizeType(t: string | undefined): string {
  return t && (TYPE_VALUES as readonly string[]).includes(t) ? t : "Note";
}
function normalizeDevopsAction(s: string | undefined): string {
  return s === "create" || s === "link" ? s : "none";
}
function normalizeWorkItemType(s: string | undefined): string {
  return s === "Bug" ? "Bug" : "User Story";
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
  lines.push("status, assignedTo, and `area`. Return an empty array only if genuinely nothing new was raised.");
  lines.push("");
  lines.push("AREAS (tabs): every new minute needs an `area` — the topic group it belongs to.");
  lines.push("Reuse one of the existing areas listed below whenever it fits (copy it exactly);");
  lines.push("only invent a new area for a genuinely new topic. Avoid defaulting everything to \"General\".");
  lines.push("");
  lines.push("DEVOPS (optional — on any update OR new item). If the meeting says to create a DevOps");
  lines.push("work item / user story / bug, or to link/track an existing work item, set on that entry:");
  lines.push("- devopsAction: \"create\", \"link\", or \"none\" (default \"none\").");
  lines.push("- devopsWorkItemType: \"Bug\" for a defect/bug, otherwise \"User Story\" (for create).");
  lines.push("- devopsWorkItemId: the existing work item number, e.g. \"5821\" (for link only).");
  lines.push("Do NOT choose a DevOps project — the user selects that.");
  lines.push("");
  lines.push("Rules: assignedTo must exactly match an allowed user or be an empty string.");
  lines.push(`Allowed users: [${users.join(", ")}]`);
  const existingAreas = [...new Set(openItems.map((i) => i.area).filter(Boolean))].sort();
  if (existingAreas.length) {
    lines.push(`Existing areas (reuse these): ${existingAreas.map((a) => `"${a}"`).join(", ")}`);
  }
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
