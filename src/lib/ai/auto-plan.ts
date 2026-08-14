// AutoMode planner — ports the on-prem AutoModeService logic.
// Given a transcript + existing project/meeting/minute context, asks Gemini
// to decide project + meeting + minutes (new vs follow-up) in one call.

import { db } from "@/lib/db";
import { generateJson } from "./provider";
import { normalizeTags } from "@/lib/tags";
import { deriveTitle } from "@/lib/minute-title";

export interface PlanMinute {
  type: "new" | "followup";
  referenceMinuteId: string | null;
  referenceMinuteTitle: string | null;
  statusChange: string;
  area: string;
  title: string;
  description: string;
  minuteType: "Note" | "To-Do" | "Action" | "Devops";
  // Title of the Action in THIS SAME meeting that this task belongs under (""
  // = standalone). Resolved to raisedFromRootId at commit; scoped to this
  // meeting only, so no history lookup is needed.
  parentTitle: string;
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
          parentTitle: { type: "STRING" },
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
  today?: string,
  opts?: { priorTitles?: string[]; priorAreas?: string[]; newMeetingOnly?: boolean }
): Promise<AutoPlan> {
  // New-meeting mode (the Auto page): this is a brand-new meeting, so there's no
  // point loading the org's history to hunt for follow-ups — that huge context
  // is exactly what made analysis slow. Load only the user roster (for assignee
  // matching); the prompt sees "(no existing projects)" and treats everything as
  // new. Filing under an existing project stays a manual choice, and continuing a
  // project with its history is what the Follow-up flow is for.
  const context: Context = opts?.newMeetingOnly
    ? { projects: [], users: await loadUsers(orgId) }
    : await loadContext(orgId);
  const prompt = buildPrompt(transcript, context, today, opts?.priorTitles, opts?.priorAreas);

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
    // Only a task can sit under an Action; ignore it on anything else, and never
    // let an item parent itself.
    parentTitle:
      ["To-Do", "Devops"].includes(m.minuteType) &&
      (m.parentTitle || "").trim().toLowerCase() !== (m.title || "").trim().toLowerCase()
        ? (m.parentTitle || "").trim()
        : "",
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

// Just the roster, for the new-meeting fast path (no history needed).
async function loadUsers(orgId: string): Promise<string[]> {
  const users = await db.user.findMany({ where: { orgId }, select: { displayName: true } });
  return users.map((u) => u.displayName);
}

// Keep the prompt bounded no matter how much history the org has — a huge
// open-minutes list makes every analyse call slow (and can push it past 60s).
const MAX_PROJECTS = 20;
const MAX_OPEN_PER_PROJECT = 12;
const MAX_DESC_CHARS = 80;

async function loadContext(orgId: string): Promise<Context> {
  const projects = await db.project.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: MAX_PROJECTS,
    include: {
      meetings: {
        orderBy: { meetingDate: "desc" },
        take: 3,
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
      description: (m.description || "").slice(0, MAX_DESC_CHARS),
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
      // Only the most-recent open items per project — enough for follow-up
      // detection without ballooning the prompt.
      openMinutes: (openByProject[p.id] ?? []).slice(-MAX_OPEN_PER_PROJECT)
    })),
    users: users.map((u) => u.displayName)
  };
}

function buildPrompt(
  transcript: string,
  ctx: Context,
  todayOverride?: string,
  priorTitles?: string[],
  priorAreas?: string[]
): string {
  // Prefer the caller's local date; the server clock is UTC and would be a day
  // behind for ahead-of-UTC timezones in the morning.
  const today = todayOverride || new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push("You are the auto-planner for a meeting minutes system.");
  lines.push("Given a meeting transcript, decide project + meeting + minutes in ONE JSON reply.");
  lines.push("");
  lines.push("### MINUTES TO EXTRACT");
  lines.push("Group by TOPIC, not by sentence. If the team talked about one thing for several");
  lines.push("minutes, that is ONE minute whose description covers the whole discussion — NOT a");
  lines.push("string of one-sentence fragments. Never split a single topic into an item plus");
  lines.push("several loose notes: fold that context into the item's own description.");
  lines.push("- Skip pure small talk. Prefer FEWER, RICHER minutes over many thin ones.");
  lines.push("- Aim for one minute per real topic — typically 5-15; do NOT exceed 30.");
  lines.push("- EVERY minute MUST have a `title`: a short few-word headline (e.g. \"Fix Costco EDI delivery info\"). NEVER leave title empty.");
  lines.push("- `description`: the substance of what was said, in the item's own words.");
  lines.push("");
  lines.push("### MINUTE TYPES (they are a hierarchy — choose deliberately)");
  lines.push("- \"Action\": a piece of work / an initiative the team discussed. This is the UMBRELLA:");
  lines.push("  its description should capture the WHOLE discussion about it — 2-4 sentences covering");
  lines.push("  the context, what was agreed, and any concerns raised.");
  lines.push("- \"To-Do\": ONE specific task to be carried out, usually for an Action. Keep it to a single line.");
  lines.push("- \"Devops\": like a To-Do, but a task that should become a DevOps work item. Single line.");
  lines.push("- \"Note\": information, context or a decision that is not a task. A Note MAY be several");
  lines.push("  sentences — put all the related discussion in ONE note rather than several small ones.");
  lines.push("Rule of thumb: the idea/initiative is an Action; the concrete tasks under it are To-Do or");
  lines.push("Devops; everything else discussed is a Note. Do NOT emit a To-Do that merely restates its Action.");
  lines.push("");
  lines.push("### LINKING TASKS TO THEIR ACTION");
  lines.push("When a To-Do or Devops is a task for an Action you are ALSO returning in this reply, set");
  lines.push("`parentTitle` to that Action's exact title, so it is tracked underneath it.");
  lines.push("- Copy the parent's `title` character-for-character; otherwise leave `parentTitle` empty.");
  lines.push("- ONLY link to an Action from THIS meeting (one you are returning now, or one listed under");
  lines.push("  'ALREADY CAPTURED EARLIER IN THIS MEETING'). Never link to an older meeting's item.");
  lines.push("- Leave `parentTitle` empty for a standalone task, and on every Note and Action.");
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
  lines.push("- Keep areas BROAD. Never create two areas that mean nearly the same thing (e.g.");
  lines.push("  \"Identity & Access\" and \"Identity Management\", or \"Recruitment\" and \"Recruitment");
  lines.push("  Process\") — pick ONE and put both items in it. A tab holding a single item is");
  lines.push("  usually a sign it should have been folded into a broader one.");
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
  // When the client analyses a long meeting in chunks, tell the model what
  // earlier chunks already captured so it extends the list instead of repeating.
  if (priorTitles && priorTitles.length) {
    lines.push("");
    lines.push("### ALREADY CAPTURED EARLIER IN THIS MEETING");
    lines.push(
      "These minutes were already extracted from an EARLIER part of this SAME meeting. Do NOT repeat them. From the transcript portion below, extract ONLY items that are new; if it merely adds detail to one already captured, skip it."
    );
    for (const t of priorTitles.slice(0, 80)) lines.push(`- ${t}`);
  }
  // Areas earlier chunks already opened. Without this each chunk invents its own
  // synonyms and a single meeting fans out across a dozen near-duplicate tabs.
  if (priorAreas && priorAreas.length) {
    lines.push("");
    lines.push("### AREAS ALREADY USED IN THIS MEETING");
    lines.push(
      "Earlier parts of this SAME meeting already filed minutes under these areas. REUSE them verbatim wherever an item fits — only invent a new area for a genuinely different subject, and never a synonym of one below."
    );
    for (const a of priorAreas.slice(0, 30)) lines.push(`- "${a}"`);
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
