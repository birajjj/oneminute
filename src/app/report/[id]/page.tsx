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

  // Split this meeting's minutes: brand-new items (parentMinuteId null) vs
  // updates to carried-forward items (parentMinuteId = the ongoing item's root).
  const newItems = meeting.minutes.filter((m) => !m.parentMinuteId);
  const updateItems = meeting.minutes.filter((m) => m.parentMinuteId);

  // For each updated item, find its status just BEFORE this meeting so the report
  // can show progress as "prior → new" (e.g. In Progress → Resolved).
  const rootIds = [...new Set(updateItems.map((m) => m.parentMinuteId!).filter(Boolean))];
  const priorStatusByRoot = new Map<string, string>();
  if (rootIds.length > 0) {
    const priorEntries = await db.minute.findMany({
      where: {
        orgId: user.orgId,
        OR: [{ id: { in: rootIds } }, { parentMinuteId: { in: rootIds } }],
        meeting: { meetingDate: { lt: meeting.meetingDate } }
      },
      select: {
        id: true,
        parentMinuteId: true,
        status: true,
        createdAt: true,
        meeting: { select: { meetingDate: true } }
      }
    });
    const latest = new Map<string, { date: number; created: number; status: string }>();
    for (const e of priorEntries) {
      const root = e.parentMinuteId ?? e.id;
      const date = e.meeting.meetingDate.getTime();
      const created = e.createdAt.getTime();
      const cur = latest.get(root);
      if (!cur || date > cur.date || (date === cur.date && created > cur.created)) {
        latest.set(root, { date, created, status: e.status });
      }
    }
    for (const [root, v] of latest) priorStatusByRoot.set(root, v.status);
  }

  const data: ReportData = {
    meetingId: meeting.id,
    title: meeting.title,
    date: meeting.meetingDate.toISOString(),
    projectName: meeting.project.name,
    attendee: meeting.attendee,
    newMinutes: newItems.map((m) => ({
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
    updates: updateItems.map((m) => {
      const priorEnum = priorStatusByRoot.get(m.parentMinuteId!) ?? "New";
      return {
        id: m.id,
        area: m.area || "General",
        title: m.title,
        note: m.description,
        type: TYPE_LABEL[m.type] ?? m.type,
        status: STATUS_LABEL[m.status] ?? m.status,
        priorStatus: STATUS_LABEL[priorEnum] ?? priorEnum,
        assignedTo: m.assignedTo?.displayName ?? null,
        dueDate: m.dueDate ? m.dueDate.toISOString() : null
      };
    }),
    attachments: meeting.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      size: a.size
    }))
  };

  return <ReportClient data={data} />;
}
