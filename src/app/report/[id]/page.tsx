import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import ReportClient, { type ReportData, type ReportItem } from "./ReportClient";

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

  // Brand-new items raised this meeting vs updates to carried-forward items.
  const newEntries = meeting.minutes.filter((m) => !m.parentMinuteId);
  const updateEntries = meeting.minutes.filter((m) => m.parentMinuteId);

  // An update entry is stored as a "Note" and carries only the note text — the
  // ITEM's identity (title, type, area, what it was raised under) lives on its
  // thread root, so load those.
  const rootIds = [...new Set(updateEntries.map((m) => m.parentMinuteId!))];
  const roots = rootIds.length
    ? await db.minute.findMany({
        where: { orgId: user.orgId, id: { in: rootIds } },
        select: {
          id: true,
          title: true,
          type: true,
          area: true,
          raisedFromRootId: true,
          devopsItemId: true,
          dueDate: true,
          assignedTo: { select: { displayName: true } }
        }
      })
    : [];
  const rootById = new Map(roots.map((r) => [r.id, r]));

  // Each updated item's status just BEFORE this meeting, so progress reads as
  // "prior → new" (e.g. In Progress → Resolved).
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

  // One flat list first; nesting is applied below.
  const flat: (ReportItem & { raisedFrom: string | null })[] = [];

  for (const m of updateEntries) {
    const root = rootById.get(m.parentMinuteId!);
    const priorEnum = priorStatusByRoot.get(m.parentMinuteId!) ?? "New";
    flat.push({
      id: m.id,
      rootId: m.parentMinuteId!,
      area: (root?.area || m.area || "General").trim(),
      title: root?.title ?? m.title,
      // The ITEM's type — not "Note", which is how the update entry is stored.
      type: TYPE_LABEL[root?.type ?? "Note"] ?? "Note",
      status: STATUS_LABEL[m.status] ?? m.status,
      priorStatus: STATUS_LABEL[priorEnum] ?? priorEnum,
      isUpdate: true,
      note: m.description,
      assignedTo: m.assignedTo?.displayName ?? root?.assignedTo?.displayName ?? null,
      dueDate: (m.dueDate ?? root?.dueDate)?.toISOString() ?? null,
      tags: m.tags ?? [],
      devopsItemId: m.devopsItemId ?? root?.devopsItemId ?? null,
      children: [],
      raisedFrom: root?.raisedFromRootId ?? null
    });
  }

  for (const m of newEntries) {
    flat.push({
      id: m.id,
      rootId: m.id,
      area: (m.area || "General").trim(),
      title: m.title,
      type: TYPE_LABEL[m.type] ?? m.type,
      status: STATUS_LABEL[m.status] ?? m.status,
      priorStatus: null,
      isUpdate: false,
      note: m.description,
      assignedTo: m.assignedTo?.displayName ?? null,
      dueDate: m.dueDate ? m.dueDate.toISOString() : null,
      tags: m.tags ?? [],
      devopsItemId: m.devopsItemId ?? null,
      children: [],
      raisedFrom: m.raisedFromRootId ?? null
    });
  }

  // Nest a task under the item it was raised from, when that parent is also in
  // this report — so a workstream and its tasks read as ONE block instead of
  // repeating the same story several times.
  const byRoot = new Map(flat.map((i) => [i.rootId, i]));
  const top: ReportItem[] = [];
  for (const item of flat) {
    const parent = item.raisedFrom ? byRoot.get(item.raisedFrom) : undefined;
    if (parent && parent !== item) parent.children.push(item);
    else top.push(item);
  }
  // Ongoing work first within a group, then newly raised.
  const order = (a: ReportItem, b: ReportItem) => Number(b.isUpdate) - Number(a.isUpdate);
  top.sort(order);
  top.forEach((t) => t.children.sort(order));

  const data: ReportData = {
    meetingId: meeting.id,
    title: meeting.title,
    date: meeting.meetingDate.toISOString(),
    projectName: meeting.project.name,
    attendee: meeting.attendee,
    description: meeting.description,
    items: top,
    attachments: meeting.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      size: a.size
    }))
  };

  return <ReportClient data={data} />;
}
