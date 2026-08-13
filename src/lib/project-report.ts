import { db } from "@/lib/db";

// Shapes a project's minutes into one CURRENT-STATE item per thread (like the
// project board): status/description come from the latest entry, identity from
// the root. Shared by the project report page and its AI-summary endpoint.

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

export interface ProjectItem {
  id: string;
  area: string;
  title: string;
  description: string | null; // latest note
  type: string; // label
  status: string; // current, label
  assignedTo: string | null;
  dueDate: string | null; // ISO
  tags: string[];
  devopsItemId: number | null;
  lastActivity: string; // ISO
}

export async function loadProjectItems(
  orgId: string,
  projectId: string
): Promise<ProjectItem[]> {
  const minutes = await db.minute.findMany({
    where: { orgId, meeting: { projectId } },
    orderBy: { createdAt: "asc" },
    include: {
      assignedTo: { select: { displayName: true } },
      meeting: { select: { meetingDate: true } }
    }
  });

  const threads: Record<string, typeof minutes> = {};
  const rootById = new Map<string, (typeof minutes)[number]>();
  for (const m of minutes) {
    const rootId = m.parentMinuteId ?? m.id;
    (threads[rootId] ??= []).push(m);
    if (!m.parentMinuteId) rootById.set(m.id, m);
  }

  const items: ProjectItem[] = [];
  for (const [rootId, entries] of Object.entries(threads)) {
    const root = rootById.get(rootId);
    if (!root) continue;

    let latest = entries[0];
    for (const e of entries) {
      const et = e.meeting.meetingDate.getTime();
      const lt = latest.meeting.meetingDate.getTime();
      if (et > lt || (et === lt && e.createdAt > latest.createdAt)) latest = e;
    }

    // Most recent entry that has a note, falling back to the root's own text.
    const noteEntry = entries
      .slice()
      .sort((a, b) => {
        const d = b.meeting.meetingDate.getTime() - a.meeting.meetingDate.getTime();
        return d !== 0 ? d : b.createdAt.getTime() - a.createdAt.getTime();
      })
      .find((e) => e.description && e.description.trim());

    items.push({
      id: rootId,
      area: root.area || "General",
      title: root.title,
      description: noteEntry?.description ?? root.description,
      type: TYPE_LABEL[root.type] ?? root.type,
      status: STATUS_LABEL[latest.status] ?? latest.status,
      assignedTo: root.assignedTo?.displayName ?? null,
      dueDate: root.dueDate ? root.dueDate.toISOString() : null,
      tags: latest.tags ?? [],
      devopsItemId: root.devopsItemId ?? null,
      lastActivity: latest.meeting.meetingDate.toISOString()
    });
  }

  return items;
}
