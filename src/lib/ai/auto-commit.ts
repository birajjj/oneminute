// Commits an approved AutoPlan to the database in a single transaction:
// create project if needed → create meeting → register areas → insert minutes.

import { db } from "@/lib/db";
import type { AutoPlan } from "./auto-plan";
import type { MinuteType, MinuteStatus } from "@prisma/client";

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
    const meetingDate = parseDate(plan.meeting.meetingDate) ?? new Date();
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
        await tx.minute.create({
          data: {
            orgId,
            meetingId: meeting.id,
            area: (m.area || "General").trim(),
            title: m.title.trim(),
            description: m.description || null,
            type: MINUTE_TYPE_MAP[m.minuteType] ?? "Note",
            status: STATUS_MAP[m.status] ?? "New",
            parentMinuteId:
              m.type === "followup" && m.referenceMinuteId
                ? m.referenceMinuteId
                : null,
            // Action-like items persist into follow-up meetings until Completed
            isPersistent: ["To-Do", "Action", "Devops"].includes(m.minuteType),
            dueDate: parseDate(m.dueDate),
            devopsArea: null
          }
        });
        minutesSaved += 1;
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
  });
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s || !s.trim()) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
