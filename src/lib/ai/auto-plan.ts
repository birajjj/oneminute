// AutoMode planner — ports the on-prem AutoModeService logic.
// Given a transcript + existing project/meeting/minute context, asks Gemini
// to decide project + meeting + minutes (new vs follow-up) in one call.

import { db } from "@/lib/db";
import { generateJson } from "./provider";
import { normalizeTags } from "@/lib/tags";

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
  tags: string[]; // governance flags: Decision / Scope / Governance
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
          tags: { type: "ARRAY", items: { type: "STRING" } },
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
  transcript: string,
  today?: string
): Promise<AutoPlan> {
  const context = await loadContext(orgId);
  const prompt = buildPrompt(transcript, context, today);

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
    // The AI occasionally returns a minute with content but an empty title. Fall
    // back to a short version of the description so it's still saveable (the user
    // can edit it). A minute with neither title nor description stays blank and
    // is dropped at commit.
    title: m.title?.trim() || deriveTitle(m.description),
    description: m.description || "",
    minuteType: (["Note", "To-Do", "Action", "Devops"].includes(m.minuteType)
      ? m.minuteType
      : "Note") as PlanMinute["minuteType"],
    status: m.status || "New",
    assignedTo: m.assignedTo || "",
    dueDate: m.dueDate || "",
    isDevopsItem: !!m.isDevopsItem,
    tags: normalizeTags(m.tags),
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

  // Visibility: an occasional AI run returns a good meeting/summary but an empty
  // or title-less minutes array. Log the shape so a ghost meeting can be traced.
  const titled = data.minutes.filter((m) => m.title.trim()).length;
  console.log(
    `[auto-plan] minutes=${data.minutes.length} titled=${titled} ` +
      `titles=${JSON.stringify(data.minutes.map((m) => m.title).slice(0, 20))} rawLen=${raw?.length ?? 0}`
  );

  data.raw = raw;
  return data;
}

// ---------------------------------------------------------------------------

interface Context {
  projects: Array<{
    id: string;
    name: string;
    /** Area/tab names already used in this project — reuse these where they fit. */
    areas: string[];
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
        select: { id: true, title: true, meetingDate: true }
      }
    }
  });

  // All minutes across these projects, so we can derive each item's CURRENT
  // status from its latest entry (point-in-time model: a root's status is not
  // overwritten, so "open" must be judged by the newest entry in the thread).
  const projectIds = projects.map((p) => p.id);
  const minutes = await db.minute.findMany({
    where: { orgId, meeting: { projectId: { in: projectIds } } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      area: true,
      parentMinuteId: true,
      meeting: { select: { projectId: true, meetingDate: true } }
    }
  });

  const entriesByRoot: Record<string, typeof minutes> = {};
  for (const m of minutes) {
    const rid = m.parentMinuteId ?? m.id;
    (entriesByRoot[rid] ??= []).push(m);
  }
  const currentStatusOf = (rootId: string): string => {
    const entries = entriesByRoot[rootId] ?? [];
    let latest = entries[0];
    for (const e of entries) {
      if (e.meeting.meetingDate.getTime() >= latest.meeting.meetingDate.getTime()) latest = e;
    }
    return latest?.status ?? "New";
  };

  // Open ROOT items per project (an item can only be followed up via its root).
  const openByProject: Record<string, Context["projects"][number]["openMinutes"]> = {};
  for (const m of minutes) {
    if (m.parentMinuteId) continue;
    const cur = currentStatusOf(m.id);
    if (cur === "Completed" || cur === "Cancelled") continue;
    (openByProject[m.meeting.projectId] ??= []).push({
      id: m.id,
      title: m.title,
      description: (m.description || "").slice(0, 200),
      status: cur,
      area: m.area
    });
  }

  // Area/tab names already in use per project, so the AI reuses them instead of
  // inventing near-duplicates ("Development" vs "Dev Work") across meetings.
  const areasByProject: Record<string, Set<string>> = {};
  for (const m of minutes) {
    const a = (m.area || "").trim();
    if (!a) continue;
    (areasByProject[m.meeting.projectId] ??= new Set()).add(a);
  }

  const users = await db.user.findMany({
    where: { orgId },
    select: { displayName: true }
  });

  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      areas: [...(areasByProject[p.id] ?? [])].sort(),
      recentMeetings: p.meetings.map((m) => ({
        id: m.id,
        title: m.title,
        date: m.meetingDate.toISOString().slice(0, 10)
      })),
      openMinutes: openByProject[p.id] ?? []
    })),
    users: users.map((u) => u.displayName)
  };
}

function buildPrompt(transcript: string, ctx: Context, todayOverride?: string): string {
  // Prefer the caller's local date; the server clock is UTC and would be a day
  // behind for ahead-of-UTC timezones in the morning.
  const today = todayOverride || new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push("You are the auto-planner for a meeting minutes system.");
  lines.push("Given a meeting transcript, decide project + meeting + minutes in ONE JSON reply.");
  lines.push("");
  lines.push("### MINUTES TO EXTRACT");
  lines.push("- Capture each distinct decision, action item, and important discussion point as its own minute.");
  lines.push("- Merge trivially-related points; skip pure small talk. Capture discussion points as 'Note'.");
  lines.push("- Aim for the meaningful items — typically 8-20 minutes; do NOT exceed 30.");
  lines.push("- EVERY minute MUST have a `title`: a short few-word headline (e.g. \"Fix Costco EDI delivery info\"). NEVER leave title empty.");
  lines.push("- `description`: ONE concise sentence with the source detail — distinct from the title, not a paragraph.");
  lines.push("");
  lines.push("### FOLLOW-UP DETECTION");
  lines.push("Follow-ups ONLY make sense within the SAME project you select in project.action.");
  lines.push("CRITICAL: only set type='followup' + referenceMinuteId when the referenced open minute is listed UNDER the project you selected. NEVER link to an open minute from a different project, even if the wording is similar.");
  lines.push("If project.action = 'create_new', there are no prior minutes to follow up — EVERY minute must be type='new'.");
  lines.push("When following up, use statusChange like 'In Progress -> Completed' if the transcript implies it.");
  lines.push("New topics, or anything in a brand-new project → type='new'.");
  lines.push("");
  lines.push("### AREAS (tabs)");
  lines.push("Every minute MUST have an `area` — the topic group it belongs to. Areas become tabs.");
  lines.push("- Group the meeting's minutes into 2-6 meaningful areas by subject, e.g. \"Development\", \"Testing / QA\", \"Data Migration\", \"DevOps\", \"Infrastructure\", \"Reporting\".");
  lines.push("- Name areas after the SUBJECT discussed, not the minute type. Never use a person's name.");
  lines.push("- REUSE an existing area name listed under the selected project whenever it fits — copy it exactly. Only invent a new area for a genuinely new topic.");
  lines.push("- Use \"General\" only for items that truly fit no topic. Do NOT put everything in General.");
  lines.push("");
  lines.push("### FLAGS (tags)");
  lines.push("Set `tags` on a minute to any of these that apply, otherwise an empty array:");
  lines.push("- \"Decision\": the team decided, agreed, chose or settled something.");
  lines.push("- \"Scope\": changes what is in or out of scope (added, dropped, deferred, descoped, pushed to a later phase).");
  lines.push("- \"Governance\": process, sign-off, approval, compliance, risk, budget or escalation.");
  lines.push("Use only those exact three words. Most minutes have NO flags — flag only what genuinely qualifies.");
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
      if (p.areas.length) {
        lines.push(`   existing areas (reuse these): ${p.areas.map((a) => `"${a}"`).join(", ")}`);
      }
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

// A short title derived from the description, used when the AI leaves the title
// blank. Empty in → empty out (a contentless minute is dropped at commit).
function deriveTitle(desc: string | null | undefined): string {
  const d = (desc || "").trim();
  if (!d) return "";
  return d.length <= 70 ? d : d.slice(0, 67).trimEnd() + "…";
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
