// Commits a follow-up meeting: creates the meeting (linked to its parent),
// records an update against each carried-forward open item (as a follow-up
// minute + a live status change on the root), and inserts any brand-new
// minutes. One transaction, mirroring auto-commit.ts conventions.
//
// SERVER-ONLY.

import { db } from "@/lib/db";
import type { MinuteType, MinuteStatus } from "@prisma/client";
import { createOrLinkWorkItem, devopsConfigured } from "@/lib/devops";
import { normalizeTags } from "@/lib/tags";
import { hasContent, titleOrDerived } from "@/lib/minute-title";

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
  Resolved: "Resolved",
  Closed: "Completed",
  Completed: "Completed",
  Cancelled: "Cancelled"
};

export interface FollowUpUpdateInput {
  rootMinuteId: string;
  noUpdate: boolean;
  type: string; // label — the update entry's type (Note/To-Do/Action/Devops)
  status: string; // label, e.g. "In Progress"
  note: string;
  assignedTo: string;
  dueDate: string;
  // Governance flags. These live on the ITEM, so updating them here rewrites the
  // root minute's flags rather than tagging this one update.
  tags: string[];
  // DevOps (only when the user armed it)
  devopsAction: string; // "none" | "create" | "link"
  devopsProject: string;
  devopsWorkItemType: string; // "User Story" | "Bug"
  devopsWorkItemId: string;
  // Extra minutes raised under this item this meeting (a note, a to-do, a devops).
  // Each becomes its own trackable root, linked back to the item for grouping.
  subEntries: FollowUpNewMinuteInput[];
}

export interface FollowUpNewMinuteInput {
  // To-dos / devops raised under this new minute (one level — a task has none).
  children?: FollowUpNewMinuteInput[];
  area: string;
  title: string;
  description: string;
  type: string; // label
  status: string; // label
  assignedTo: string;
  dueDate: string;
  tags: string[]; // governance flags
  devopsAction: string;
  devopsProject: string;
  devopsWorkItemType: string;
  devopsWorkItemId: string;
}

export interface FollowUpInput {
  parentMeetingId: string;
  meetingTitle: string;
  meetingDate: string;
  summary?: string;
  transcript?: string; // verbatim record, kept with the meeting // AI recap → the follow-up meeting's description
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

      // Number same-titled follow-ups so multiple in a day are distinguishable
      // (a chain of follow-ups otherwise all read "… - Follow-up <date>"). The
      // first keeps the plain title; the next collision becomes " #2", then "#3".
      const baseTitle = (input.meetingTitle || "Follow-up Meeting").trim();
      let title = baseTitle;
      for (let n = 2; ; n++) {
        const clash = await tx.meeting.findFirst({
          where: { orgId, projectId: parent.projectId, title },
          select: { id: true }
        });
        if (!clash) break;
        title = `${baseTitle} #${n}`;
      }

      const meeting = await tx.meeting.create({
        data: {
          orgId,
          projectId: parent.projectId,
          title,
          description: input.summary?.trim() || null,
          transcript: input.transcript?.trim() || null,
          meetingDate: resolveMeetingDate(input.meetingDate),
          ownerUserId: userId,
          parentMeetingIdRaw: parent.id
        }
      });

      const areaSet = new Set<string>();

      // Create a brand-new root minute (its own thread). Used by both the
      // "New minutes this meeting" list and the per-item sub-entries; the latter
      // pass raisedFromRootId so Browse can group them under the parent item.
      async function createRootMinute(
        m: FollowUpNewMinuteInput,
        raisedFromRootId: string | null,
        areaOverride?: string
      ): Promise<string | null> {
        if (!hasContent(m.title, m.description)) return null;
        const area = (areaOverride || m.area || "General").trim();
        areaSet.add(area);

        let devopsItemId: number | null = null;
        let devopsArea: string | null = null;
        if (m.devopsAction === "create" || m.devopsAction === "link") {
          try {
            const dv = await commitDevops({
              action: m.devopsAction,
              workItemId: m.devopsWorkItemId,
              project: m.devopsProject,
              workItemType: m.devopsWorkItemType,
              title: m.title,
              description: m.description
            });
            devopsItemId = dv.id;
            devopsArea = dv.project;
          } catch (dex) {
            warnings.push(`DevOps for "${m.title}": ${dex instanceof Error ? dex.message : "failed"}`);
          }
        }

        const createdRoot = await tx.minute.create({
          select: { id: true },
          data: {
            orgId,
            meetingId: meeting.id,
            area,
            title: titleOrDerived(m.title, m.description),
            description: m.description?.trim() || null,
            type: TYPE_MAP[m.type] ?? "Note",
            status: STATUS_MAP[m.status] ?? "New",
            parentMinuteId: null,
            raisedFromRootId,
            isPersistent: ["To-Do", "Action", "Devops"].includes(m.type),
            tags: normalizeTags(m.tags),
            assignedToUserId: resolveUser(m.assignedTo),
            dueDate: parseDate(m.dueDate),
            devopsItemId,
            devopsArea
          }
        });
        return createdRoot.id;
      }

      // ---- Updates to carried-forward open items ----
      let updated = 0;
      let created = 0; // counts brand-new minutes AND sub-entries raised under items
      for (const u of input.updates) {
        const root = await tx.minute.findUnique({
          where: { id: u.rootMinuteId },
          select: {
            id: true,
            area: true,
            title: true,
            type: true,
            status: true,
            assignedToUserId: true,
            dueDate: true,
            meeting: { select: { projectId: true } }
          }
        });
        // Guard: only update items that belong to this follow-up's project.
        if (!root || root.meeting.projectId !== parent.projectId) {
          if (!u.noUpdate) warnings.push("Skipped an update to an item outside this project.");
          continue;
        }

        // Item-level edits from the header (type / assignee / due) apply to the
        // ROOT — they're the item's own properties, not point-in-time — and run
        // for every reviewed item, even one with no status/note change.
        const rootPatch: {
          type?: MinuteType;
          assignedToUserId?: string | null;
          dueDate?: Date | null;
        } = {};
        const newType = TYPE_MAP[u.type];
        if (newType && newType !== root.type) rootPatch.type = newType;
        const newAssignee = resolveUser(u.assignedTo);
        if (newAssignee !== root.assignedToUserId) rootPatch.assignedToUserId = newAssignee;
        const curDue = root.dueDate ? root.dueDate.toISOString().slice(0, 10) : "";
        if ((u.dueDate || "").trim() !== curDue) rootPatch.dueDate = parseDate(u.dueDate);
        if (Object.keys(rootPatch).length > 0) {
          await tx.minute.update({ where: { id: root.id }, data: rootPatch });
        }

        // Point-in-time: flags go on THIS meeting's entry, never backdated onto
        // the root. They carry forward from the item's newest entry, so a change
        // only counts as an update when it differs from what was carried in.
        const entryTags = normalizeTags(u.tags);
        const latest = await tx.minute.findFirst({
          where: { orgId, OR: [{ id: root.id }, { parentMinuteId: root.id }] },
          orderBy: [{ meeting: { meetingDate: "desc" } }, { createdAt: "desc" }],
          select: { tags: true, status: true }
        });
        const tagsChanged = entryTags.join(",") !== normalizeTags(latest?.tags ?? []).join(",");
        // The item's CURRENT status = its newest entry's status (point-in-time
        // never overwrites the root, so root.status is stale). Compare against this
        // so an unchanged item isn't treated as "changed" every follow-up.
        const currentStatus = latest?.status ?? root.status;

        // Extra minutes raised under this item this meeting → their own roots,
        // grouped under the item. Done first (before the no-action short-circuit)
        // so you can raise a new to-do under an item you took no other action on.
        const subEntries = (u.subEntries ?? []).filter((s) => s.title.trim());
        let subCreated = 0;
        for (const s of subEntries) {
          if (await createRootMinute(s, root.id, root.area || "General")) subCreated++;
        }
        created += subCreated;

        // "No action this meeting" — record a marker note so the review is on the
        // record. It carries a note ("No action this meeting."), so it shows in the
        // follow-up table; note-less entries are hidden there instead.
        if (u.noUpdate) {
          const area = root.area || "General";
          areaSet.add(area);
          await tx.minute.create({
            data: {
              orgId,
              meetingId: meeting.id,
              area,
              title: root.title,
              description: "No action this meeting.",
              type: "Note", // an item's update is always a Note; its real type is on the card
              status: root.status,
              tags: entryTags,
              parentMinuteId: root.id,
              isPersistent: false
            }
          });
          updated++;
          continue;
        }

        const mappedStatus = STATUS_MAP[u.status];
        const statusChanged = !!mappedStatus && mappedStatus !== currentStatus;
        const hasNote = !!u.note && !!u.note.trim();
        const wantsDevops = u.devopsAction === "create" || u.devopsAction === "link";
        // Nothing meaningful to record — treat as an implicit "no update".
        // A flag change counts; so does raising sub-items (the item still needs
        // its own entry this meeting so Browse has a card to group them under).
        if (!hasNote && !statusChanged && !wantsDevops && !tagsChanged && subCreated === 0) continue;

        const newStatus = mappedStatus ?? currentStatus;
        const area = root.area || "General";
        areaSet.add(area);

        // An item's own follow-up update is always recorded as a Note — it's
        // commentary on the item, not a fresh to-do. The item's real type stays
        // on its root, so the Browse card header still reads To-Do/Action/etc.
        const updateType: MinuteType = "Note";

        // Optionally create/link a DevOps work item for this update.
        let devopsItemId: number | null = null;
        let devopsArea: string | null = null;
        if (wantsDevops) {
          try {
            const dv = await commitDevops({
              action: u.devopsAction,
              workItemId: u.devopsWorkItemId,
              project: u.devopsProject,
              workItemType: u.devopsWorkItemType,
              title: root.title,
              description: u.note
            });
            devopsItemId = dv.id;
            devopsArea = dv.project;
          } catch (dex) {
            warnings.push(`DevOps for "${root.title}": ${dex instanceof Error ? dex.message : "failed"}`);
          }
        }

        // The update itself: a follow-up minute linked to the thread root.
        await tx.minute.create({
          data: {
            orgId,
            meetingId: meeting.id,
            area,
            title: root.title,
            description: u.note?.trim() || null,
            type: updateType,
            status: newStatus,
            tags: entryTags,
            parentMinuteId: root.id,
            isPersistent: false,
            assignedToUserId: resolveUser(u.assignedTo),
            dueDate: parseDate(u.dueDate),
            devopsItemId,
            devopsArea
          }
        });

        // Point-in-time: the update is recorded as its own entry; we do NOT
        // overwrite the item's status here. Item-level edits (type/assignee/due)
        // were already applied to the root above.
        updated++;
      }

      // ---- Brand-new minutes for this meeting ----
      for (const m of input.newMinutes) {
        const newRootId = await createRootMinute(m, null);
        if (newRootId) {
          created++;
          // Tasks the user attached to this brand-new minute — the parent had no
          // id until now, so they are written straight after it.
          for (const child of m.children ?? []) {
            if (await createRootMinute(child, newRootId, m.area || "General")) created++;
          }
        }
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

// Wraps the shared DevOps create/link helper with the string -> union coercion
// the follow-up inputs need. Throws if DevOps isn't configured (caller warns).
async function commitDevops(input: {
  action: string;
  workItemId: string;
  project: string;
  workItemType: string;
  title: string;
  description: string;
}): Promise<{ id: number; project: string | null }> {
  if (!devopsConfigured()) throw new Error("DevOps not configured");
  return createOrLinkWorkItem({
    action: input.action === "link" ? "link" : "create",
    workItemId: input.workItemId,
    project: input.project,
    workItemType: input.workItemType === "Bug" ? "Bug" : "User Story",
    title: input.title,
    description: input.description?.trim() || null,
    state: null
  });
}

// The client sends a date-only string; combine it with the current time so
// meetings stay distinct and ordered (see the same note in auto-commit.ts).
function resolveMeetingDate(s: string | null | undefined): Date {
  const now = new Date();
  if (!s || !s.trim()) return now;
  const str = s.trim();

  // Full ISO instant (what the client sends — already the user's local wall
  // clock) — store it verbatim.
  if (str.includes("T")) {
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  // Bare YYYY-MM-DD — anchor at noon so the calendar day survives timezone render.
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  }

  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? now : parsed;
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s || !s.trim()) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
