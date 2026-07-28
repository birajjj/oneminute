import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import BrowseClient, { type BrowseMeeting, type BrowseProject } from "./BrowseClient";

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
      minutes: m.minutes.map((mn) => ({
        id: mn.id,
        area: mn.area || "General",
        title: mn.title,
        description: mn.description,
        type: TYPE_LABEL[mn.type] ?? mn.type,
        status: STATUS_LABEL[mn.status] ?? mn.status,
        isFollowUp: !!mn.parentMinuteId,
        isPersistent: mn.isPersistent,
        assignedTo: mn.assignedToUserId,
        dueDate: mn.dueDate ? mn.dueDate.toISOString() : null
      }))
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
      userName={user.displayName}
    />
  );
}
