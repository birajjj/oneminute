// Loads the data for a follow-up meeting workspace: the open action items to
// carry forward from a parent meeting's project, each with its update history.
//
// "Open item" = a THREAD ROOT (no parentMinuteId) that is persistent (a To-Do /
// Action / Devops) and not yet Closed or Cancelled. NOTE: "Closed" is the DB
// enum value `Completed` (relabelled in the UI); a Resolved item still carries
// forward. In the option-A thread model the root holds the item's live status,
// so these are exactly the things still pending that a follow-up reviews.
//
// SERVER-ONLY.

import { db } from "@/lib/db";

const TYPE_LABEL: Record<string, string> = {
  Note: "Note",
  Todo: "To-Do",
  Action: "Action",
  Devops: "Devops"
};

const STATUS_LABEL: Record<string, string> = {
  New: "New",
  Initiated: "Initiated",
  InProgress: "In Progress",
  Resolved: "Resolved",
  Completed: "Closed",
  Cancelled: "Cancelled"
};

export interface OpenItemHistory {
  title: string;
  description: string | null;
  type: string;
  status: string;
  date: string;
  meetingTitle: string;
}

export interface OpenItem {
  id: string;
  area: string;
  title: string;
  description: string | null;
  type: string; // label
  status: string; // label
  assignedTo: string | null;
  dueDate: string | null;
  devopsItemId: number | null;
  tags: string[]; // flags currently on the item (from its newest entry)
  // If set, this open item was raised under another item in an earlier follow-up.
  // The review nests it under that parent so it travels with the original minute.
  raisedFromRootId: string | null;
  // When the item was first captured — its root meeting's date/time.
  capturedAt: string;
  history: OpenItemHistory[];
}

export interface FollowUpData {
  parent: {
    id: string;
    title: string;
    date: string;
    projectId: string;
    projectName: string;
    attachments: {
      id: string;
      fileName: string;
      contentType: string;
      size: number;
      createdAt: string;
    }[];
  };
  areas: string[];
  openItems: OpenItem[];
  // Identity of every item referenced as a "raised-from" parent — including
  // completed ones — so the review can show a raised item's parent as a
  // read-only header even when the parent no longer carries forward.
  raisedParents: Record<string, { title: string; status: string; open: boolean }>;
}

export async function loadFollowUpData(
  orgId: string,
  parentMeetingId: string
): Promise<FollowUpData | null> {
  const parent = await db.meeting.findFirst({
    where: { id: parentMeetingId, orgId },
    include: {
      project: { select: { id: true, name: true } },
      attachments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, fileName: true, contentType: true, size: true, createdAt: true }
      }
    }
  });
  if (!parent) return null;

  const projectId = parent.projectId;

  // Every minute in this project — used to find open roots and build history.
  const minutes = await db.minute.findMany({
    where: { orgId, meeting: { projectId } },
    orderBy: { createdAt: "asc" },
    include: {
      assignedTo: { select: { displayName: true } },
      meeting: { select: { title: true, meetingDate: true } }
    }
  });

  // Follow-up history keyed by thread root.
  const historyByRoot: Record<string, OpenItemHistory[]> = {};
  for (const m of minutes) {
    if (!m.parentMinuteId) continue;
    (historyByRoot[m.parentMinuteId] ??= []).push({
      title: m.title,
      description: m.description,
      type: TYPE_LABEL[m.type] ?? m.type,
      status: STATUS_LABEL[m.status] ?? m.status,
      date: m.meeting.meetingDate.toISOString(),
      meetingTitle: m.meeting.title
    });
  }

  // Derive each item's CURRENT status from its latest entry (root + follow-ups).
  // Since we no longer overwrite a root's status (point-in-time model), an item
  // is "open" based on its newest entry, not the root's original status.
  const entriesByRoot: Record<string, typeof minutes> = {};
  for (const m of minutes) {
    const rid = m.parentMinuteId ?? m.id;
    (entriesByRoot[rid] ??= []).push(m);
  }
  const latestEntryOf = (rootId: string) => {
    const entries = entriesByRoot[rootId] ?? [];
    let latest = entries[0];
    for (const e of entries) {
      const et = e.meeting.meetingDate.getTime();
      const lt = latest.meeting.meetingDate.getTime();
      if (et > lt || (et === lt && e.createdAt > latest.createdAt)) latest = e;
    }
    return latest;
  };
  const currentStatusOf = (rootId: string): string => latestEntryOf(rootId)?.status ?? "New";
  const isOpenStatus = (s: string) => s !== "Completed" && s !== "Cancelled";

  // Roots that still have at least one OPEN item raised under them. A Closed
  // parent that hosts an open child must stay in the review (editable) so the
  // child nests under it and the parent itself can still be edited or reopened,
  // rather than collapsing into a read-only "context" box.
  const parentsWithOpenChildren = new Set<string>();
  for (const m of minutes) {
    if (m.parentMinuteId || !m.isPersistent || !m.raisedFromRootId) continue;
    if (isOpenStatus(currentStatusOf(m.id))) parentsWithOpenChildren.add(m.raisedFromRootId);
  }

  const openItems: OpenItem[] = minutes
    .filter((m) => {
      if (m.parentMinuteId || !m.isPersistent) return false;
      // Open items, plus Closed ones that still host an open child.
      return isOpenStatus(currentStatusOf(m.id)) || parentsWithOpenChildren.has(m.id);
    })
    .map((m) => {
      const cur = currentStatusOf(m.id);
      return {
        id: m.id,
        area: m.area || "General",
        title: m.title,
        description: m.description,
        type: TYPE_LABEL[m.type] ?? m.type,
        status: STATUS_LABEL[cur] ?? cur, // show CURRENT status, not the root's original
        assignedTo: m.assignedTo?.displayName ?? null,
        dueDate: m.dueDate ? m.dueDate.toISOString() : null,
        devopsItemId: m.devopsItemId ?? null,
        // Flags carry forward from the item's newest entry (same rule as status),
        // so a follow-up opens showing what's currently flagged.
        tags: latestEntryOf(m.id)?.tags ?? [],
        raisedFromRootId: m.raisedFromRootId ?? null,
        capturedAt: m.meeting.meetingDate.toISOString(),
        history: historyByRoot[m.id] ?? []
      };
    });

  const areas = [...new Set(openItems.map((i) => i.area))].sort();

  // Resolve the identity of each raised-from parent (even completed ones) so the
  // review can render a raised item under its parent as a read-only header.
  const rootById = new Map(minutes.filter((m) => !m.parentMinuteId).map((m) => [m.id, m]));
  const openItemIds = new Set(openItems.map((i) => i.id));
  const raisedParents: Record<string, { title: string; status: string; open: boolean }> = {};
  for (const it of openItems) {
    const pid = it.raisedFromRootId;
    if (!pid || raisedParents[pid]) continue;
    const proot = rootById.get(pid);
    if (!proot) continue;
    const cur = currentStatusOf(pid);
    raisedParents[pid] = {
      title: proot.title,
      status: STATUS_LABEL[cur] ?? cur,
      open: openItemIds.has(pid)
    };
  }

  return {
    parent: {
      id: parent.id,
      title: parent.title,
      date: parent.meetingDate.toISOString(),
      projectId: parent.project.id,
      projectName: parent.project.name,
      attachments: parent.attachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        contentType: a.contentType,
        size: a.size,
        createdAt: a.createdAt.toISOString()
      }))
    },
    areas,
    openItems,
    raisedParents
  };
}
