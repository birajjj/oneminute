import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import DashboardClient, { DashItem, RosterMember } from "./DashboardClient";

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

// Best-effort "which roster person is this login account?" A login ("biraj.josi",
// biraj.josi@gmail.com) and the roster row it represents ("Biraj Joshi") are
// separate records with no hard link, so we match on shared name tokens and let
// the user correct it. Returns the roster id to default the picker to.
function guessMe(
  login: { displayName: string; email: string },
  members: { id: string; displayName: string }[]
): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const loginTokens = new Set(
    [...norm(login.displayName).split(" "), ...norm(login.email.split("@")[0]).split(" ")].filter(
      Boolean
    )
  );
  let bestId: string | null = null;
  let bestScore = 0;
  for (const m of members) {
    const tokens = norm(m.displayName).split(" ").filter(Boolean);
    const score = tokens.reduce((n, t) => n + (loginTokens.has(t) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestId = m.id;
    }
  }
  return bestId ?? members[0]?.id ?? null;
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/dashboard");

  // Assignable team members (the roster) — the people a dashboard can be about.
  const members: RosterMember[] = await db.user.findMany({
    where: { orgId: user.orgId, isRoster: true },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true }
  });

  // Everything in the org, so we can rebuild each item's thread and know its
  // CURRENT state — then keep only the items that have an owner.
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
    // Ownership is the item's identity → the root's assignee. Keep every owned
    // item; the client filters to the selected person.
    if (!root.assignedToUserId) continue;

    // Latest entry by meeting date then creation — the item's current state.
    let latest = entries[0];
    for (const e of entries) {
      const et = e.meeting.meetingDate.getTime();
      const lt = latest.meeting.meetingDate.getTime();
      if (et > lt || (et === lt && e.createdAt > latest.createdAt)) latest = e;
    }

    // The note to surface: the most recent entry that has a description (latest
    // update), falling back to the root's original.
    const noteEntry = entries
      .slice()
      .sort((a, b) => {
        const d = b.meeting.meetingDate.getTime() - a.meeting.meetingDate.getTime();
        return d !== 0 ? d : b.createdAt.getTime() - a.createdAt.getTime();
      })
      .find((e) => e.description && e.description.trim());

    items.push({
      id: rootId,
      assigneeId: root.assignedToUserId,
      latestEntryId: latest.id,
      title: root.title,
      description: noteEntry?.description ?? root.description,
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

  const defaultAssigneeId = guessMe(
    { displayName: user.displayName, email: user.email },
    members
  );

  return (
    <DashboardClient
      items={items}
      members={members}
      defaultAssigneeId={defaultAssigneeId}
      userId={user.id}
      userName={user.displayName}
    />
  );
}
