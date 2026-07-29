// Commits a follow-up meeting: creates the meeting (linked to its parent),
// records an update against each carried-forward open item (as a follow-up
// minute + a live status change on the root), and inserts any brand-new
// minutes. One transaction, mirroring auto-commit.ts conventions.
//
// SERVER-ONLY.

import { db } from "@/lib/db";
import type { MinuteType, MinuteStatus } from "@prisma/client";

const TYPE_MAP: Record<string, MinuteType> = {
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

export interface FollowUpUpdateInput {
  rootMinuteId: string;
  noUpdate: boolean;
  status: string; // label, e.g. "In Progress"
  note: string;
  assignedTo: string;
  dueDate: string;
}

export interface FollowUpNewMinuteInput {
  area: string;
  title: string;
  description: string;
  type: string; // label
  status: string; // label
  assignedTo: string;
  dueDate: string;
}

export interface FollowUpInput {
  parentMeetingId: string;
  meetingTitle: string;
  meetingDate: string;
  updates: FollowUpUpdateInput[];
  newMinutes: FollowUpNewMinuteInput[];
}

export interface FollowUpResult {
  meetingId: string;
  updated: number;
  created: number;
  warnings: string[];
}

export async function commitFollowUp(
  orgId: string,
  userId: string,
  input: FollowUpInput
): Promise<FollowUpResult> {
  const warnings: string[] = [];

  return db.$transaction(
    async (tx) => {
      const parent = await tx.meeting.findFirst({
        where: { id: input.parentMeetingId, orgId },
        select: { id: true, projectId: true }
      });
      if (!parent) throw new Error("parent meeting not found");

      const users = await tx.user.findMany({
        where: { orgId },
        select: { id: true, displayName: true }
      });
      const userIdByName = new Map(
        users.map((u) => [u.displayName.toLowerCase(), u.id])
      );
      const resolveUser = (name: string): string | null =>
        name ? userIdByName.get(name.toLowerCase()) ?? null : null;

      const meeting = await tx.meeting.create({
        data: {
          orgId,
          projectId: parent.projectId,
          title: (input.meetingTitle || "Follow-up Meeting").trim(),
          meetingDate: resolveMeetingDate(input.meetingDate),
          ownerUserId: userId,
          parentMeetingIdRaw: parent.id
        }
      });

      const areaSet = new Set<string>();

      // ---- Updates to carried-forward open items ----
      let updated = 0;
      for (const u of input.updates) {
        if (u.noUpdate) continue;

        const root = await tx.minute.findUnique({
          where: { id: u.rootMinuteId },
          select: {
            id: true,
            area: true,
            title: true,
            type: true,
            status: true,
            meeting: { select: { projectId: true } }
          }
        });
        // Guard: only update items that belong to this follow-up's project.
        if (!root || root.meeting.projectId !== parent.projectId) {
          warnings.push("Skipped an update to an item outside this project.");
          continue;
        }

        const mappedStatus = STATUS_MAP[u.status];
        const statusChanged = !!mappedStatus && mappedStatus !== root.status;
        const hasNote = !!u.note && !!u.note.trim();
        // Nothing meaningful to record — treat as an implicit "no update".
        if (!hasNote && !statusChanged) continue;

        const newStatus = mappedStatus ?? root.status;
        const area = root.area || "General";
        areaSet.add(area);

        // The update itself: a follow-up minute linked to the thread root.
        await tx.minute.create({
          data: {
            orgId,
            meetingId: meeting.id,
            area,
            title: root.title,
            description: u.note?.trim() || null,
            type: root.type,
            status: newStatus,
            parentMinuteId: root.id,
            isPersistent: false,
            assignedToUserId: resolveUser(u.assignedTo),
            dueDate: parseDate(u.dueDate)
          }
        });

        // The root carries the item's live status forward.
        await tx.minute.update({
          where: { id: root.id },
          data: {
            status: newStatus,
            ...(u.assignedTo ? { assignedToUserId: resolveUser(u.assignedTo) } : {}),
            ...(u.dueDate ? { dueDate: parseDate(u.dueDate) } : {})
          }
        });
        updated++;
      }

      // ---- Brand-new minutes for this meeting ----
      let created = 0;
      for (const m of input.newMinutes) {
        if (!m.title.trim()) continue;
        const area = (m.area || "General").trim();
        areaSet.add(area);
        await tx.minute.create({
          data: {
            orgId,
            meetingId: meeting.id,
            area,
            title: m.title.trim(),
            description: m.description?.trim() || null,
            type: TYPE_MAP[m.type] ?? "Note",
            status: STATUS_MAP[m.status] ?? "New",
            parentMinuteId: null,
            isPersistent: ["To-Do", "Action", "Devops"].includes(m.type),
            assignedToUserId: resolveUser(m.assignedTo),
            dueDate: parseDate(m.dueDate)
          }
        });
        created++;
      }

      // ---- Areas ----
      if (areaSet.size === 0) areaSet.add("General");
      for (const areaName of areaSet) {
        await tx.meetingArea.create({
          data: { orgId, meetingId: meeting.id, areaName }
        });
      }

      await tx.auditLog.create({
        data: {
          orgId,
          userId,
          action: "followup_commit",
          tableName: "meetings",
          rowId: meeting.id,
          after: { meetingId: meeting.id, updated, created }
        }
      });

      return { meetingId: meeting.id, updated, created, warnings };
    },
    { maxWait: 15000, timeout: 60000 }
  );
}

// The client sends a date-only string; combine it with the current time so
// meetings stay distinct and ordered (see the same note in auto-commit.ts).
function resolveMeetingDate(s: string | null | undefined): Date {
  const now = new Date();
  if (!s || !s.trim()) return now;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds()
    );
  }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? now : parsed;
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s || !s.trim()) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
