import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import ProjectBoardClient, { BoardItem, BoardThreadEntry } from "./ProjectBoardClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project board" };

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

export default async function ProjectBoardPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/project/${id}`);

  const project = await db.project.findFirst({
    where: { id, orgId: user.orgId },
    select: { id: true, name: true }
  });
  if (!project) redirect("/browse");

  const minutes = await db.minute.findMany({
    where: { orgId: user.orgId, meeting: { projectId: id } },
    orderBy: { createdAt: "asc" },
    include: {
      assignedTo: { select: { displayName: true } },
      meeting: { select: { title: true, meetingDate: true } }
    }
  });

  const members = await db.user.findMany({
    where: { orgId: user.orgId, isRoster: true },
    orderBy: { displayName: "asc" },
    select: { displayName: true }
  });

  // Group every minute into its thread (root id = parentMinuteId or own id).
  const threads: Record<string, typeof minutes> = {};
  const rootById = new Map<string, (typeof minutes)[number]>();
  for (const m of minutes) {
    const rootId = m.parentMinuteId ?? m.id;
    (threads[rootId] ??= []).push(m);
    if (!m.parentMinuteId) rootById.set(m.id, m);
  }

  // One board item per thread root, at its CURRENT state (latest entry).
  const items: BoardItem[] = [];
  for (const [rootId, entries] of Object.entries(threads)) {
    const root = rootById.get(rootId);
    if (!root) continue; // orphaned entry with no root in this project

    // Latest entry by meeting date then creation.
    let latest = entries[0];
    for (const e of entries) {
      const et = e.meeting.meetingDate.getTime();
      const lt = latest.meeting.meetingDate.getTime();
      if (et > lt || (et === lt && e.createdAt > latest.createdAt)) latest = e;
    }

    const thread: BoardThreadEntry[] = entries
      .slice()
      .sort((a, b) => (a.meeting.meetingDate < b.meeting.meetingDate ? 1 : -1))
      .map((e) => ({
        id: e.id,
        isRoot: !e.parentMinuteId,
        description: e.description,
        status: STATUS_LABEL[e.status] ?? e.status,
        date: e.meeting.meetingDate.toISOString(),
        meetingTitle: e.meeting.title
      }));

    items.push({
      id: rootId,
      area: root.area || "General",
      title: root.title,
      type: TYPE_LABEL[root.type] ?? root.type,
      status: STATUS_LABEL[latest.status] ?? latest.status,
      assignedTo: root.assignedTo?.displayName ?? null,
      dueDate: root.dueDate ? root.dueDate.toISOString() : null,
      tags: latest.tags ?? [],
      devopsItemId: root.devopsItemId ?? null,
      updateCount: entries.length - 1,
      raisedFromTitle: root.raisedFromRootId
        ? rootById.get(root.raisedFromRootId)?.title ?? null
        : null,
      lastActivity: latest.meeting.meetingDate.toISOString(),
      // Every meeting this item's thread touches — for the meeting filter.
      meetingIds: [...new Set(entries.map((e) => e.meetingId))],
      thread
    });
  }

  const areas = [...new Set(items.map((i) => i.area))].sort();

  // Meetings that have items, newest first — for the meeting filter dropdown.
  const meetingMap = new Map<string, { id: string; title: string; date: string }>();
  for (const m of minutes) {
    if (!meetingMap.has(m.meetingId)) {
      meetingMap.set(m.meetingId, {
        id: m.meetingId,
        title: m.meeting.title,
        date: m.meeting.meetingDate.toISOString()
      });
    }
  }
  const meetings = [...meetingMap.values()].sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <ProjectBoardClient
      project={project}
      items={items}
      areas={areas}
      meetings={meetings}
      members={members.map((m) => m.displayName)}
      userName={user.displayName}
    />
  );
}
