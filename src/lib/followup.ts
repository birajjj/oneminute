// Loads the data for a follow-up meeting workspace: the open action items to
// carry forward from a parent meeting's project, each with its update history.
//
// "Open item" = a THREAD ROOT (no parentMinuteId) that is persistent (a To-Do /
// Action / Devops) and not yet Completed or Cancelled. In the option-A thread
// model the root holds the item's live status, so these are exactly the things
// still pending that a follow-up meeting needs to review one by one.
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
  Completed: "Completed",
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
  history: OpenItemHistory[];
}

export interface FollowUpData {
  parent: {
    id: string;
    title: string;
    date: string;
    projectId: string;
    projectName: string;
  };
  areas: string[];
  openItems: OpenItem[];
}

export async function loadFollowUpData(
  orgId: string,
  parentMeetingId: string
): Promise<FollowUpData | null> {
  const parent = await db.meeting.findFirst({
    where: { id: parentMeetingId, orgId },
    include: { project: { select: { id: true, name: true } } }
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

  const openItems: OpenItem[] = minutes
    .filter(
      (m) =>
        !m.parentMinuteId &&
        m.isPersistent &&
        m.status !== "Completed" &&
        m.status !== "Cancelled"
    )
    .map((m) => ({
      id: m.id,
      area: m.area || "General",
      title: m.title,
      description: m.description,
      type: TYPE_LABEL[m.type] ?? m.type,
      status: STATUS_LABEL[m.status] ?? m.status,
      assignedTo: m.assignedTo?.displayName ?? null,
      dueDate: m.dueDate ? m.dueDate.toISOString() : null,
      devopsItemId: m.devopsItemId ?? null,
      history: historyByRoot[m.id] ?? []
    }));

  const areas = [...new Set(openItems.map((i) => i.area))].sort();

  return {
    parent: {
      id: parent.id,
      title: parent.title,
      date: parent.meetingDate.toISOString(),
      projectId: parent.project.id,
      projectName: parent.project.name
    },
    areas,
    openItems
  };
}
