// The report's content, loaded once and shared by the PDF attachment and the
// email body — so the two can never drift apart.
//
// Ordering matches the on-screen report: commitments, then outcomes, then
// background. Each row is claimed exactly once.
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
  Resolved: "Resolved",
  Completed: "Closed",
  Cancelled: "Cancelled"
};
const ACTION_TYPES = ["To-Do", "Action", "Devops"];
export const FLAGS = ["Decision", "Scope", "Governance"];

export interface ReportRow {
  title: string;
  type: string;
  status: string;
  note: string | null;
  area: string;
  owner: string | null;
  due: string | null; // already formatted for display
  tags: string[];
}

export interface ReportContent {
  meetingTitle: string;
  projectName: string;
  when: string;
  summary: string | null;
  actions: ReportRow[];
  decisions: ReportRow[];
  notes: ReportRow[];
  total: number;
}

export async function loadReportContent(
  orgId: string,
  meetingId: string
): Promise<ReportContent | null> {
  const meeting = await db.meeting.findFirst({
    where: { id: meetingId, orgId },
    include: {
      project: { select: { name: true } },
      minutes: {
        orderBy: [{ area: "asc" }, { createdAt: "asc" }],
        include: { assignedTo: { select: { displayName: true } } }
      }
    }
  });
  if (!meeting) return null;

  // Update entries are stored as notes against a thread root; the ITEM's real
  // title/type lives on that root, so resolve them (same rule as the report page).
  const rootIds = [
    ...new Set(meeting.minutes.filter((m) => m.parentMinuteId).map((m) => m.parentMinuteId!))
  ];
  const roots = rootIds.length
    ? await db.minute.findMany({
        where: { orgId, id: { in: rootIds } },
        select: { id: true, title: true, type: true, area: true }
      })
    : [];
  const rootById = new Map(roots.map((r) => [r.id, r]));

  const fmtDue = (d: Date | null) =>
    d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : null;

  const rows: ReportRow[] = meeting.minutes.map((m) => {
    const root = m.parentMinuteId ? rootById.get(m.parentMinuteId) : undefined;
    return {
      title: root?.title ?? m.title,
      type: TYPE_LABEL[root?.type ?? m.type] ?? "Note",
      status: STATUS_LABEL[m.status] ?? m.status,
      note: m.description,
      area: (root?.area || m.area || "General").trim(),
      owner: m.assignedTo?.displayName ?? null,
      due: fmtDue(m.dueDate),
      tags: m.tags ?? []
    };
  });

  const actions = rows.filter((r) => ACTION_TYPES.includes(r.type));
  const rest = rows.filter((r) => !ACTION_TYPES.includes(r.type));
  const flagged = (r: ReportRow) => r.tags.some((t) => FLAGS.includes(t));

  return {
    meetingTitle: meeting.title,
    projectName: meeting.project.name,
    when: meeting.meetingDate.toLocaleDateString("en-AU", {
      year: "numeric",
      month: "long",
      day: "numeric"
    }),
    summary: meeting.description,
    actions,
    decisions: rest.filter(flagged),
    notes: rest.filter((r) => !flagged(r)),
    total: rows.length
  };
}

/** A filename-safe version of the meeting title. */
export function reportFileName(title: string, when: string): string {
  const safe = (title || "meeting").replace(/[^\w\d\-. ]+/g, "").trim().replace(/\s+/g, "-");
  return `${safe.slice(0, 60)}-report.pdf`;
}
