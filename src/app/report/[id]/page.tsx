import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import ReportClient, { type ReportData } from "./ReportClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Meeting Report" };

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

export default async function ReportPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/report/${id}`);

  const meeting = await db.meeting.findFirst({
    where: { id, orgId: user.orgId },
    include: {
      project: { select: { id: true, name: true } },
      attachments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, fileName: true, size: true }
      },
      minutes: {
        orderBy: [{ area: "asc" }, { createdAt: "asc" }],
        include: { assignedTo: { select: { displayName: true } } }
      }
    }
  });
  if (!meeting) redirect("/browse");

  const data: ReportData = {
    meetingId: meeting.id,
    title: meeting.title,
    date: meeting.meetingDate.toISOString(),
    projectName: meeting.project.name,
    attendee: meeting.attendee,
    minutes: meeting.minutes.map((m) => ({
      id: m.id,
      area: m.area || "General",
      title: m.title,
      description: m.description,
      type: TYPE_LABEL[m.type] ?? m.type,
      status: STATUS_LABEL[m.status] ?? m.status,
      assignedTo: m.assignedTo?.displayName ?? null,
      dueDate: m.dueDate ? m.dueDate.toISOString() : null,
      tags: m.tags ?? [],
      devopsItemId: m.devopsItemId ?? null
    })),
    attachments: meeting.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      size: a.size
    }))
  };

  return <ReportClient data={data} />;
}
