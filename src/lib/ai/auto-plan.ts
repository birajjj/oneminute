// AutoMode planner — ports the on-prem AutoModeService logic.
// Given a transcript + existing project/meeting/minute context, asks Gemini
// to decide project + meeting + minutes (new vs follow-up) in one call.

import { db } from "@/lib/db";
import { generateJson } from "./gemini";

export interface PlanMinute {
  type: "new" | "followup";
  referenceMinuteId: string | null;
  referenceMinuteTitle: string | null;
  statusChange: string;
  area: string;
  title: string;
  description: string;
  minuteType: "Note" | "To-Do" | "Action" | "Devops";
  status: string;
  assignedTo: string;
  dueDate: string;
  isDevopsItem: boolean;
  confidence: "high" | "medium" | "low";
  approved: boolean;

  // DevOps action chosen by the user in the review screen (not from the AI).
  // "none" = no work item; "create" = make a new one; "link" = attach existing.
  devopsAction: "none" | "create" | "link";
  devopsProject: string;                     // project name for create
  devopsWorkItemType: "User Story" | "Bug";  // for create
  devopsWorkItemId: string;                  // for link (existing id)
}

export interface AutoPlan {
  project: {
    action: "use_existing" | "create_new";
    existingProjectId: string | null;
    existingProjectName: string | null;
    newProjectName: string | null;
    reason: string;
    confidence: string;
  };
  meeting: {
    action: "new" | "followup";
    followUpToMeetingId: string | null;
    followUpToMeetingTitle: string | null;
    title: string;
    description: string;
    meetingDate: string;
    attendees: string;
    reason: string;
    confidence: string;
  };
  minutes: PlanMinute[];
  summary: string;
  raw?: string;
}

const responseSchema = {
  type: "OBJECT",
  properties: {
    project: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING" },
        existingProjectId: { type: "STRING" },
        existingProjectName: { type: "STRING" },
        newProjectName: { type: "STRING" },
        reason: { type: "STRING" },
        confidence: { type: "STRING" }
      },
      required: ["action"]
    },
    meeting: {
      type: "OBJECT",
      properties: {
        action: { type: "STRING" },
        followUpToMeetingId: { type: "STRING" },
        followUpToMeetingTitle: { type: "STRING" },
        title: { type: "STRING" },
        description: { type: "STRING" },
        meetingDate: { type: "STRING" },
        attendees: { type: "STRING" },
        reason: { type: "STRING" },
        confidence: { type: "STRING" }
      },
      required: ["action", "title"]
    },
    minutes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING" },
          referenceMinuteId: { type: "STRING" },
          referenceMinuteTitle: { type: "STRING" },
          statusChange: { type: "STRING" },
          area: { type: "STRING" },
          title: { type: "STRING" },
          description: { type: "STRING" },
          minuteType: { type: "STRING" },
          status: { type: "STRING" },
          assignedTo: { type: "STRING" },
          dueDate: { type: "STRING" },
          isDevopsItem: { type: "BOOLEAN" },
          confidence: { type: "STRING" }
        },
        required: ["type", "title"]
      }
    },
    summary: { type: "STRING" }
  },
  required: ["project", "meeting", "minutes"]
};

export async function buildAutoPlan(
  orgId: string,
  transcript: string
): Promise<AutoPlan> {
  const context = await loadContext(orgId);
  const prompt = buildPrompt(transcript, context);

  const { data, raw } = await generateJson<AutoPlan>({
    prompt,
    schema: responseSchema,
    temperature: 0.4
  });

  if (!data) {
    return emptyPlan(transcript, raw);
  }

  // Normalize + default every minute so the UI can bind safely.
  data.minutes = (data.minutes || []).map((m) => ({
    type: m.type === "followup" ? "followup" : "new",
    referenceMinuteId: emptyToNull(m.referenceMinuteId),
    referenceMinuteTitle: emptyToNull(m.referenceMinuteTitle),
    statusChange: m.statusChange || "",
    area: m.area || "General",
    title: m.title || "",
    description: m.description || "",
    minuteType: (["Note", "To-Do", "Action", "Devops"].includes(m.minuteType)
      ? m.minuteType
      : "Note") as PlanMinute["minuteType"],
    status: m.status || "New",
    assignedTo: m.assignedTo || "",
    dueDate: m.dueDate || "",
    isDevopsItem: !!m.isDevopsItem,
    confidence: (["high", "medium", "low"].includes(m.confidence)
      ? m.confidence
      : "medium") as PlanMinute["confidence"],
    approved: true,
    // DevOps defaults: pre-arm "create" for items the AI flagged, else "none".
    devopsAction: (m.isDevopsItem || m.minuteType === "Devops" ? "create" : "none") as PlanMinute["devopsAction"],
    devopsProject: "",
    devopsWorkItemType: "User Story" as PlanMinute["devopsWorkItemType"],
    devopsWorkItemId: ""
  }));

  // GUARD: strip cross-project follow-up links so the review UI matches what
  // commit will actually save. A follow-up is only valid if its referenceMinuteId
  // belongs to the project the AI selected. New projects have no valid targets.
  const selectedProjectId =
    data.project?.action === "use_existing" ? data.project.existingProjectId : null;
  const validRefIds = new Set<string>(
    selectedProjectId
      ? (context.projects.find((p) => p.id === selectedProjectId)?.openMinutes ?? []).map(
          (om) => om.id
        )
      : []
  );

  data.minutes = data.minutes.map((m) => {
    if (m.type === "followup" && (!m.referenceMinuteId || !validRefIds.has(m.referenceMinuteId))) {
      return { ...m, type: "new", referenceMinuteId: null, referenceMinuteTitle: null, statusChange: "" };
    }
    return m;
  });

  data.raw = raw;
  return data;
}

// ---------------------------------------------------------------------------

interface Context {
  projects: Array<{
    id: string;
    name: string;
    recentMeetings: Array<{ id: string; title: string; date: string }>;
    openMinutes: Array<{
      id: string;
      title: string;
      description: string;
      status: string;
      area: string;
    }>;
  }>;
  users: string[];
}

async function loadContext(orgId: string): Promise<Context> {
  const projects = await db.project.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      meetings: {
        orderBy: { meetingDate: "desc" },
        take: 5,
        include: {
          minutes: {
            where: { status: { notIn: ["Completed", "Cancelled"] } },
            orderBy: { createdAt: "desc" },
            take: 40
          }
        }
      }
    }
  });

  const users = await db.user.findMany({
    where: { orgId },
    select: { displayName: true }
  });

  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      recentMeetings: p.meetings.map((m) => ({
        id: m.id,
        title: m.title,
        date: m.meetingDate.toISOString().slice(0, 10)
      })),
      openMinutes: p.meetings.flatMap((m) =>
        m.minutes.map((mn) => ({
          id: mn.id,
          title: mn.title,
          description: (mn.description || "").slice(0, 200),
          status: mn.status,
          area: mn.area
        }))
      )
    })),
    users: users.map((u) => u.displayName)
  };
}

function buildPrompt(transcript: string, ctx: Context): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push("You are the auto-planner for a meeting minutes system.");
  lines.push("Given a meeting transcript, decide project + meeting + minutes in ONE JSON reply.");
  lines.push("");
  lines.push("### BE EXHAUSTIVE ON MINUTES");
  lines.push("- Extract EVERY distinct topic, decision, action item, question, blocker, and status update.");
  lines.push("- Split unrelated items into separate minutes; capture discussion points as 'Note'.");
  lines.push("- A 30-min meeting has 8-20 minutes; a 60-min meeting 15-40. Prefer MORE.");
  lines.push("");
  lines.push("### FOLLOW-UP DETECTION");
  lines.push("Follow-ups ONLY make sense within the SAME project you select in project.action.");
  lines.push("CRITICAL: only set type='followup' + referenceMinuteId when the referenced open minute is listed UNDER the project you selected. NEVER link to an open minute from a different project, even if the wording is similar.");
  lines.push("If project.action = 'create_new', there are no prior minutes to follow up — EVERY minute must be type='new'.");
  lines.push("When following up, use statusChange like 'In Progress -> Completed' if the transcript implies it.");
  lines.push("New topics, or anything in a brand-new project → type='new'.");
  lines.push("");
  lines.push("### RULES");
  lines.push("- project.action 'use_existing' (set existingProjectId) when it clearly matches a listed project, else 'create_new' with newProjectName.");
  lines.push("- meeting.action 'followup' (set followUpToMeetingId) when it continues a specific prior meeting, else 'new'.");
  lines.push(`- meeting.meetingDate: YYYY-MM-DD (default ${today}).`);
  lines.push("- assignedTo must exactly match an allowed user or empty string.");
  lines.push("- minuteType one of: Note, To-Do, Action, Devops.");
  lines.push("- dueDate: YYYY-MM-DD or empty. confidence: high|medium|low.");
  lines.push("- summary: 2-3 sentences.");
  lines.push("");
  lines.push(`Allowed users: [${ctx.users.join(", ")}]`);
  lines.push("");
  lines.push("### Existing projects");
  if (ctx.projects.length === 0) {
    lines.push("(none)");
  } else {
    for (const p of ctx.projects) {
      lines.push(`- projectId=${p.id} name="${p.name}"`);
      if (p.recentMeetings.length) {
        lines.push("   recent meetings:");
        for (const m of p.recentMeetings) {
          lines.push(`    - meetingId=${m.id} date=${m.date} title="${m.title}"`);
        }
      }
      if (p.openMinutes.length) {
        lines.push("   open minutes:");
        for (const om of p.openMinutes) {
          const d = om.description ? ` — ${om.description}` : "";
          lines.push(`    - minuteId=${om.id} [${om.status}] ${om.title}${d}`);
        }
      }
    }
  }
  lines.push("");
  lines.push("### Transcript");
  lines.push(transcript);

  return lines.join("\n");
}

function emptyToNull(v: string | null | undefined): string | null {
  return v && v.trim() ? v : null;
}

function emptyPlan(transcript: string, raw: string): AutoPlan {
  return {
    project: {
      action: "create_new",
      existingProjectId: null,
      existingProjectName: null,
      newProjectName: "Untitled Project",
      reason: "model returned no parseable plan",
      confidence: "low"
    },
    meeting: {
      action: "new",
      followUpToMeetingId: null,
      followUpToMeetingTitle: null,
      title: "Untitled Meeting",
      description: "",
      meetingDate: new Date().toISOString().slice(0, 10),
      attendees: "",
      reason: "",
      confidence: "low"
    },
    minutes: [],
    summary: "",
    raw
  };
}
