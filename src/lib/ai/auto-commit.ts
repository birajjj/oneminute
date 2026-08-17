// Commits an approved AutoPlan to the database in a single transaction:
// create project if needed → create meeting → register areas → insert minutes.

import { db } from "@/lib/db";
import type { AutoPlan, PlanMinute } from "./auto-plan";
import type { MinuteType, MinuteStatus } from "@prisma/client";
import { createWorkItem, getWorkItem, devopsConfigured } from "@/lib/devops";
import { normalizeTags } from "@/lib/tags";
import { hasContent, titleOrDerived } from "@/lib/minute-title";

export interface CommitResult {
  projectId: string;
  meetingId: string;
  minutesSaved: number;
  projectCreated: boolean;
  warnings: string[];
}

const MINUTE_TYPE_MAP: Record<string, MinuteType> = {
  Note: "Note",
  "To-Do": "Todo",
  Action: "Action",
  Devops: "Devops"
};

const STATUS_MAP: Record<string, MinuteStatus> = {
  New: "New",
  Initiated: "Initiated",
  "In Progress": "InProgress",
  Resolved: "Resolved",
  Closed: "Completed",
  Completed: "Completed",
  Cancelled: "Cancelled"
};

export async function commitAutoPlan(
  orgId: string,
  userId: string,
  plan: AutoPlan
): Promise<CommitResult> {
  const warnings: string[] = [];

  return db.$transaction(async (tx) => {
    // ---- Assignee lookup (name -> userId) for this org ----
    const orgUsers = await tx.user.findMany({
      where: { orgId },
      select: { id: true, displayName: true }
    });
    const userIdByName = new Map(
      orgUsers.map((u) => [u.displayName.toLowerCase(), u.id])
    );

    // ---- Project ----
    let projectId: string;
    let projectCreated = false;

    if (plan.project.action === "use_existing" && plan.project.existingProjectId) {
      projectId = plan.project.existingProjectId;
    } else {
      const name = (plan.project.newProjectName || "Untitled Project").trim();
      // Reuse existing project of same name if present (name is unique per org).
      const existing = await tx.project.findFirst({ where: { orgId, name } });
      if (existing) {
        projectId = existing.id;
      } else {
        const created = await tx.project.create({ data: { orgId, name } });
        projectId = created.id;
        projectCreated = true;
      }
    }

    // ---- Meeting ----
    const meetingDate = resolveMeetingDate(plan.meeting.meetingDate);
    const meeting = await tx.meeting.create({
      data: {
        orgId,
        projectId,
        title: (plan.meeting.title || "Untitled Meeting").trim(),
        description: plan.meeting.description || plan.summary || null,
        meetingDate,
        attendee: plan.meeting.attendees || null,
        ownerUserId: userId,
        parentMeetingIdRaw:
          plan.meeting.action === "followup"
            ? plan.meeting.followUpToMeetingId ?? "*ALL*"
            : null
      }
    });

    // ---- Areas (unique) ----
    // Save a minute if it has a title OR a description; drop only the empties.
    const approved = (plan.minutes || []).filter(
      (m) => m.approved && hasContent(m.title, m.description)
    );
    const uniqueAreas = [
      ...new Set(approved.map((m) => (m.area || "General").trim()))
    ];
    if (uniqueAreas.length === 0) uniqueAreas.push("General");

    for (const areaName of uniqueAreas) {
      await tx.meetingArea.create({
        data: { orgId, meetingId: meeting.id, areaName }
      });
    }

    // ---- Minutes ----
    let minutesSaved = 0;
    for (const m of approved) {
      try {
        // Option A: every follow-up links to the THREAD ROOT, not the
        // immediate predecessor. If the AI referenced a minute that is itself
        // a follow-up, walk up to its root so the whole thread shares one parent.
        //
        // GUARD: a follow-up may only link to a minute in the SAME meeting's
        // project. The AI sometimes cross-links to a similarly-worded minute in
        // an unrelated project — we reject that and treat the item as new.
        let rootId: string | null = null;
        if (m.type === "followup" && m.referenceMinuteId) {
          const referenced = await tx.minute.findUnique({
            where: { id: m.referenceMinuteId },
            select: {
              id: true,
              parentMinuteId: true,
              meeting: { select: { projectId: true } }
            }
          });
          if (referenced && referenced.meeting.projectId === projectId) {
            rootId = referenced.parentMinuteId ?? referenced.id;
          } else if (referenced) {
            warnings.push(
              `"${m.title}" was flagged as a follow-up to a minute in a different project — saved as new instead.`
            );
          }
        }

        // Create or link an Azure DevOps work item if requested. Failures here
        // are non-fatal — the minute still saves, with a warning. This also keeps
        // the feature dormant until DevOps auth is configured.
        let devopsItemId: number | null = null;
        let devopsProjectName: string | null = null;
        if (m.devopsAction === "create" || m.devopsAction === "link") {
          try {
            const dv = await handleDevops(m);
            devopsItemId = dv.id;
            devopsProjectName = dv.project;
          } catch (dex) {
            warnings.push(
              `DevOps for "${m.title}": ${dex instanceof Error ? dex.message : "failed"}`
            );
          }
        }

        await tx.minute.create({
          data: {
            orgId,
            meetingId: meeting.id,
            area: (m.area || "General").trim(),
            title: titleOrDerived(m.title, m.description),
            description: m.description || null,
            type: MINUTE_TYPE_MAP[m.minuteType] ?? "Note",
            status: STATUS_MAP[m.status] ?? "New",
            parentMinuteId: rootId,
            // Map the assignee name (AI suggestion or user's dropdown pick) to a
            // roster user. Unknown names save as unassigned.
            assignedToUserId: m.assignedTo
              ? userIdByName.get(m.assignedTo.toLowerCase()) ?? null
              : null,
            // Action-like items persist into follow-up meetings until Completed
            isPersistent: ["To-Do", "Action", "Devops"].includes(m.minuteType),
            tags: normalizeTags(m.tags),
            dueDate: parseDate(m.dueDate),
            devopsItemId,
            devopsArea: devopsProjectName
          }
        });
        minutesSaved += 1;
        // Point-in-time: the follow-up is recorded as its own entry with its own
        // status; we do NOT overwrite the root item's status here.
      } catch (e) {
        warnings.push(
          `Failed to save "${m.title}": ${e instanceof Error ? e.message : "unknown"}`
        );
      }
    }

    // ---- Audit ----
    await tx.auditLog.create({
      data: {
        orgId,
        userId,
        action: "auto_commit",
        tableName: "meetings",
        rowId: meeting.id,
        after: {
          projectId,
          meetingId: meeting.id,
          minutesSaved,
          projectCreated
        }
      }
    });

    return { projectId, meetingId: meeting.id, minutesSaved, projectCreated, warnings };
  }, {
    // Commits do many sequential writes round-tripping to Sydney; the default
    // 5s interactive-transaction limit is too tight. Give it generous headroom.
    maxWait: 15000,
    timeout: 60000
  });
}

// ---------------------------------------------------------------------------
// Chunked commit — for long meetings whose minutes (+ any DevOps calls) can't
// all be written inside one 60s function. The client calls `start` once, then
// `minutes` in small batches. Each call stays well under the cap.
// ---------------------------------------------------------------------------

// Creates the project (if needed), the meeting, and all areas up front — fast,
// no DevOps, no per-minute work — in one short transaction.
export async function commitAutoPlanStart(
  orgId: string,
  userId: string,
  plan: AutoPlan,
  transcript?: string
): Promise<{ projectId: string; meetingId: string; projectCreated: boolean }> {
  return db.$transaction(
    async (tx) => {
      let projectId: string;
      let projectCreated = false;
      if (plan.project.action === "use_existing" && plan.project.existingProjectId) {
        projectId = plan.project.existingProjectId;
      } else {
        const name = (plan.project.newProjectName || "Untitled Project").trim();
        const existing = await tx.project.findFirst({ where: { orgId, name } });
        if (existing) {
          projectId = existing.id;
        } else {
          const created = await tx.project.create({ data: { orgId, name } });
          projectId = created.id;
          projectCreated = true;
        }
      }

      const meetingDate = resolveMeetingDate(plan.meeting.meetingDate);
      const meeting = await tx.meeting.create({
        data: {
          orgId,
          projectId,
          title: (plan.meeting.title || "Untitled Meeting").trim(),
          description: plan.meeting.description || plan.summary || null,
          transcript: transcript?.trim() || null,
          meetingDate,
          attendee: plan.meeting.attendees || null,
          ownerUserId: userId,
          parentMeetingIdRaw:
            plan.meeting.action === "followup"
              ? plan.meeting.followUpToMeetingId ?? "*ALL*"
              : null
        }
      });

      // Register every area from the WHOLE plan now, so tabs are complete even
      // though minutes arrive in later batches.
      const approved = (plan.minutes || []).filter(
        (m) => m.approved && hasContent(m.title, m.description)
      );
      const uniqueAreas = [...new Set(approved.map((m) => (m.area || "General").trim()))];
      if (uniqueAreas.length === 0) uniqueAreas.push("General");
      for (const areaName of uniqueAreas) {
        await tx.meetingArea.create({ data: { orgId, meetingId: meeting.id, areaName } });
      }

      await tx.auditLog.create({
        data: {
          orgId,
          userId,
          action: "auto_commit_start",
          tableName: "meetings",
          rowId: meeting.id,
          after: { projectId, meetingId: meeting.id, projectCreated }
        }
      });

      return { projectId, meetingId: meeting.id, projectCreated };
    },
    { maxWait: 15000, timeout: 30000 }
  );
}

// Writes one batch of minutes to an already-created meeting. Not wrapped in a
// long transaction: each minute (and its optional DevOps call) is independent,
// and per-minute failures become warnings — matching the single-shot commit.
export async function commitAutoPlanMinutes(
  orgId: string,
  meetingId: string,
  minutes: PlanMinute[]
): Promise<{ saved: number; warnings: string[] }> {
  const warnings: string[] = [];

  // Authorises the caller (meeting must be in their org) and gives us the
  // project for the cross-project follow-up guard.
  const meeting = await db.meeting.findFirst({
    where: { id: meetingId, orgId },
    select: { id: true, projectId: true }
  });
  if (!meeting) throw new Error("meeting not found");
  const projectId = meeting.projectId;

  const orgUsers = await db.user.findMany({
    where: { orgId },
    select: { id: true, displayName: true }
  });
  const userIdByName = new Map(orgUsers.map((u) => [u.displayName.toLowerCase(), u.id]));

  let saved = 0;
  for (const m of minutes) {
    if (!(m.approved && hasContent(m.title, m.description))) continue;
    try {
      let rootId: string | null = null;
      if (m.type === "followup" && m.referenceMinuteId) {
        const referenced = await db.minute.findUnique({
          where: { id: m.referenceMinuteId },
          select: { id: true, parentMinuteId: true, meeting: { select: { projectId: true } } }
        });
        if (referenced && referenced.meeting.projectId === projectId) {
          rootId = referenced.parentMinuteId ?? referenced.id;
        } else if (referenced) {
          warnings.push(
            `"${m.title}" was flagged as a follow-up to a minute in a different project — saved as new instead.`
          );
        }
      }

      // A task (To-Do/Devops) can be filed under an Action captured in THIS
      // meeting. Resolved by exact title within this meeting only — no history
      // lookup, so it stays fast. Unresolved → saved standalone.
      let raisedFromRootId: string | null = null;
      if (!rootId && m.parentTitle && m.parentTitle.trim()) {
        const parent = await db.minute.findFirst({
          where: {
            orgId,
            meetingId,
            title: m.parentTitle.trim(),
            parentMinuteId: null
          },
          select: { id: true }
        });
        raisedFromRootId = parent?.id ?? null;
      }

      let devopsItemId: number | null = null;
      let devopsProjectName: string | null = null;
      if (m.devopsAction === "create" || m.devopsAction === "link") {
        try {
          const dv = await handleDevops(m);
          devopsItemId = dv.id;
          devopsProjectName = dv.project;
        } catch (dex) {
          warnings.push(`DevOps for "${m.title}": ${dex instanceof Error ? dex.message : "failed"}`);
        }
      }

      await db.minute.create({
        data: {
          orgId,
          meetingId,
          area: (m.area || "General").trim(),
          title: titleOrDerived(m.title, m.description),
          description: m.description || null,
          type: MINUTE_TYPE_MAP[m.minuteType] ?? "Note",
          status: STATUS_MAP[m.status] ?? "New",
          parentMinuteId: rootId,
          raisedFromRootId,
          assignedToUserId: m.assignedTo
            ? userIdByName.get(m.assignedTo.toLowerCase()) ?? null
            : null,
          isPersistent: ["To-Do", "Action", "Devops"].includes(m.minuteType),
          tags: normalizeTags(m.tags),
          dueDate: parseDate(m.dueDate),
          devopsItemId,
          devopsArea: devopsProjectName
        }
      });
      saved += 1;
    } catch (e) {
      warnings.push(`Failed to save "${m.title}": ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  return { saved, warnings };
}

// The AI returns a date-only string like "2026-07-28" (no time). Parsing that
// alone yields midnight UTC, so every meeting would show the same wall-clock
// time. To keep meetings distinct and ordered, we combine the AI's DATE with
// the actual capture TIME (now). If the AI omits/garbles the date, fall back
// to the full current timestamp.
function resolveMeetingDate(s: string | null | undefined): Date {
  const now = new Date();
  if (!s || !s.trim()) return now;
  const str = s.trim();

  // Full ISO instant (what the client now sends, already at the user's local
  // wall-clock time) — store it verbatim.
  if (str.includes("T")) {
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  // Bare YYYY-MM-DD (e.g. an AI default). Anchor at noon so the calendar day is
  // preserved when a UTC server stores it and it's rendered in another timezone.
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  }

  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? now : parsed;
}

// Used for optional fields like a minute's due date — may legitimately be null.
function parseDate(s: string | null | undefined): Date | null {
  if (!s || !s.trim()) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Creates or links a DevOps work item for a minute. Throws on failure so the
// caller can record a warning; the minute still saves without the link.
async function handleDevops(
  m: PlanMinute
): Promise<{ id: number; project: string | null }> {
  if (!devopsConfigured()) {
    throw new Error("DevOps not configured");
  }

  if (m.devopsAction === "link") {
    const id = parseInt(m.devopsWorkItemId, 10);
    if (isNaN(id)) throw new Error("invalid work item id");
    const wi = await getWorkItem(id); // verifies it exists
    return { id: wi.id, project: wi.project };
  }

  // create
  const project = m.devopsProject.trim();
  if (!project) throw new Error("no DevOps project specified");
  // The assignee name may or may not be a DevOps identity; pass it through.
  const id = await createWorkItem({
    project,
    type: m.devopsWorkItemType,
    title: m.title.trim(),
    description: m.description || null,
    assignedTo: m.assignedTo || null,
    state: m.status || null
  });
  return { id, project };
}

