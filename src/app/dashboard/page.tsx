import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import DashboardClient, { DashItem } from "./DashboardClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "My Dashboard" };

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

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/dashboard");

  // Everything in the org, so we can rebuild each item's thread and know its
  // CURRENT state — then keep only the items this user owns.
  const minutes = await db.minute.findMany({
    where: { orgId: user.orgId },
    orderBy: { createdAt: "asc" },
    include: {
      meeting: {
        select: {
          title: true,
          meetingDate: true,
          project: { select: { id: true, name: true } }
        }
      }
    }
  });

  // Group into threads (root id = parentMinuteId or own id).
  const threads: Record<string, typeof minutes> = {};
  const rootById = new Map<string, (typeof minutes)[number]>();
  for (const m of minutes) {
    const rootId = m.parentMinuteId ?? m.id;
    (threads[rootId] ??= []).push(m);
    if (!m.parentMinuteId) rootById.set(m.id, m);
  }

  const items: DashItem[] = [];
  for (const [rootId, entries] of Object.entries(threads)) {
    const root = rootById.get(rootId);
    if (!root) continue;
    // Ownership is the item's identity → the root's assignee.
    if (root.assignedToUserId !== user.id) continue;

    // Latest entry by meeting date then creation — the item's current state.
    let latest = entries[0];
    for (const e of entries) {
      const et = e.meeting.meetingDate.getTime();
      const lt = latest.meeting.meetingDate.getTime();
      if (et > lt || (et === lt && e.createdAt > latest.createdAt)) latest = e;
    }

    items.push({
      id: rootId,
      latestEntryId: latest.id,
      title: root.title,
      type: TYPE_LABEL[root.type] ?? root.type,
      status: STATUS_LABEL[latest.status] ?? latest.status,
      area: root.area || "General",
      dueDate: root.dueDate ? root.dueDate.toISOString() : null,
      projectId: root.meeting.project.id,
      projectName: root.meeting.project.name,
      devopsItemId: root.devopsItemId ?? null,
      tags: latest.tags ?? [],
      lastActivity: latest.meeting.meetingDate.toISOString()
    });
  }

  return <DashboardClient items={items} userName={user.displayName} />;
}
