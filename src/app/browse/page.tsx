import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import BrowseClient, {
  type BrowseMeeting,
  type BrowseProject,
  type ThreadEntry
} from "./BrowseClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Meeting Minutes" };

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

export default async function BrowsePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/browse");

  const projects = await db.project.findMany({
    where: { orgId: user.orgId },
    orderBy: { name: "asc" },
    select: { id: true, name: true }
  });

  const meetings = await db.meeting.findMany({
    where: { orgId: user.orgId },
    orderBy: { meetingDate: "desc" },
    include: {
      project: { select: { id: true, name: true } },
      minutes: { orderBy: [{ area: "asc" }, { createdAt: "asc" }] }
    }
  });

  // Resolve follow-up parent meeting titles for display.
  const meetingById = new Map(meetings.map((m) => [m.id, m]));

  // Build threads: rootId -> all minutes in that thread (across every meeting),
  // newest-first. rootId = a minute's parentMinuteId, or its own id if it's a root.
  const threads: Record<string, ThreadEntry[]> = {};
  for (const m of meetings) {
    for (const mn of m.minutes) {
      const rootId = mn.parentMinuteId ?? mn.id;
      (threads[rootId] ??= []).push({
        id: mn.id,
        title: mn.title,
        description: mn.description,
        type: TYPE_LABEL[mn.type] ?? mn.type,
        status: STATUS_LABEL[mn.status] ?? mn.status,
        date: m.meetingDate.toISOString(),
        meetingTitle: m.title,
        isRoot: !mn.parentMinuteId
      });
    }
  }
  // Sort each thread newest-first.
  for (const id of Object.keys(threads)) {
    threads[id].sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  const shaped: BrowseMeeting[] = meetings.map((m) => {
    let followUpFrom: { title: string; date: string } | null = null;
    if (m.parentMeetingIdRaw && m.parentMeetingIdRaw !== "*ALL*") {
      const parent = meetingById.get(m.parentMeetingIdRaw);
      if (parent) {
        followUpFrom = {
          title: parent.title,
          date: parent.meetingDate.toISOString()
        };
      }
    } else if (m.parentMeetingIdRaw === "*ALL*") {
      followUpFrom = { title: "All prior meetings", date: "" };
    }

    return {
      id: m.id,
      title: m.title,
      date: m.meetingDate.toISOString(),
      projectId: m.project.id,
      projectName: m.project.name,
      description: m.description,
      attendee: m.attendee,
      followUpFrom,
      minutes: m.minutes.map((mn) => {
        const rootId = mn.parentMinuteId ?? mn.id;
        return {
          id: mn.id,
          rootId,
          area: mn.area || "General",
          title: mn.title,
          description: mn.description,
          type: TYPE_LABEL[mn.type] ?? mn.type,
          status: STATUS_LABEL[mn.status] ?? mn.status,
          isFollowUp: !!mn.parentMinuteId,
          isPersistent: mn.isPersistent,
          // How many entries are in this minute's thread (1 = standalone so far).
          threadCount: threads[rootId]?.length ?? 1,
          assignedTo: mn.assignedToUserId,
          dueDate: mn.dueDate ? mn.dueDate.toISOString() : null
        };
      })
    };
  });

  const shapedProjects: BrowseProject[] = projects.map((p) => ({
    id: p.id,
    name: p.name
  }));

  return (
    <BrowseClient
      meetings={shaped}
      projects={shapedProjects}
      threads={threads}
      userName={user.displayName}
    />
  );
}
