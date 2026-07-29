// Commits an approved AutoPlan to the database in a single transaction:
// create project if needed → create meeting → register areas → insert minutes.

import { db } from "@/lib/db";
import type { AutoPlan, PlanMinute } from "./auto-plan";
import type { MinuteType, MinuteStatus } from "@prisma/client";
import { createWorkItem, getWorkItem, devopsConfigured } from "@/lib/devops";

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
    const approved = (plan.minutes || []).filter(
      (m) => m.approved && m.title.trim()
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
            title: m.title.trim(),
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
            dueDate: parseDate(m.dueDate),
            devopsItemId,
            devopsArea: devopsProjectName
          }
        });
        minutesSaved += 1;

        // Auto-update the thread root's status when this follow-up implies one.
        // e.g. statusChange "In Progress -> Completed" closes the pending item.
        if (rootId && m.statusChange) {
          const newStatus = statusFromChange(m.statusChange);
          if (newStatus) {
            await tx.minute.update({
              where: { id: rootId },
              data: { status: newStatus }
            });
          }
        }
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

// The AI returns a date-only string like "2026-07-28" (no time). Parsing that
// alone yields midnight UTC, so every meeting would show the same wall-clock
// time. To keep meetings distinct and ordered, we combine the AI's DATE with
// the actual capture TIME (now). If the AI omits/garbles the date, fall back
// to the full current timestamp.
function resolveMeetingDate(s: string | null | undefined): Date {
  const now = new Date();
  if (!s || !s.trim()) return now;

  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    // Local-time date with current time-of-day.
    return new Date(
      year,
      month,
      day,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds()
    );
  }

  const parsed = new Date(s);
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

// Reads the target status out of an AI statusChange string like
// "In Progress -> Completed" and maps it to our enum. Returns null if the
// change doesn't name a status we recognise.
function statusFromChange(change: string): MinuteStatus | null {
  const parts = change.split(/->|→|=>/);
  const target = (parts[parts.length - 1] || "").trim();
  return STATUS_MAP[target] ?? null;
}
