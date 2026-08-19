// The report's content, loaded once and shared by the PDF attachment and the
// email body — so the two can never drift apart.
//
// Mirrors the on-screen report exactly: a task raised under an item is NESTED
// beneath it rather than listed separately, and the top-level ordering is
// commitments, then outcomes, then background, with each item claimed once.
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
  children: ReportRow[]; // tasks raised under this item
}

export interface ReportContent {
  meetingTitle: string;
  projectName: string;
  when: string;
  summary: string | null;
  actions: ReportRow[];
  decisions: ReportRow[];
  notes: ReportRow[];
  total: number; // counts nested items too
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

  // An update entry is stored as a note against a thread root; the ITEM's real
  // title, type and "raised under" link live on that root, so resolve them.
  const rootIds = [
    ...new Set(meeting.minutes.filter((m) => m.parentMinuteId).map((m) => m.parentMinuteId!))
  ];
  const roots = rootIds.length
    ? await db.minute.findMany({
        where: { orgId, id: { in: rootIds } },
        select: { id: true, title: true, type: true, area: true, raisedFromRootId: true }
      })
    : [];
  const rootById = new Map(roots.map((r) => [r.id, r]));

  const fmtDue = (d: Date | null) =>
    d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : null;

  // Flat first, carrying the identifiers needed to nest.
  interface Flat extends ReportRow {
    rootId: string;
    raisedFrom: string | null;
  }
  const flat: Flat[] = meeting.minutes.map((m) => {
    const root = m.parentMinuteId ? rootById.get(m.parentMinuteId) : undefined;
    return {
      rootId: m.parentMinuteId ?? m.id,
      raisedFrom: (root ? root.raisedFromRootId : m.raisedFromRootId) ?? null,
      title: root?.title ?? m.title,
      type: TYPE_LABEL[root?.type ?? m.type] ?? "Note",
      status: STATUS_LABEL[m.status] ?? m.status,
      note: m.description,
      area: (root?.area || m.area || "General").trim(),
      owner: m.assignedTo?.displayName ?? null,
      due: fmtDue(m.dueDate),
      tags: m.tags ?? [],
      children: []
    };
  });

  // Nest a task under the item it was raised from, when that parent is also in
  // this report — same rule the report page uses, so the PDF and the screen
  // group work identically.
  const byRoot = new Map(flat.map((i) => [i.rootId, i]));
  const top: Flat[] = [];
  for (const item of flat) {
    const parent = item.raisedFrom ? byRoot.get(item.raisedFrom) : undefined;
    if (parent && parent !== item) parent.children.push(item);
    else top.push(item);
  }

  // Classification is by the TOP-LEVEL item; children travel with their parent.
  const actions = top.filter((r) => ACTION_TYPES.includes(r.type));
  const rest = top.filter((r) => !ACTION_TYPES.includes(r.type));
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
    total: flat.length
  };
}

/** A filename-safe version of the meeting title. */
export function reportFileName(title: string, when: string): string {
  const safe = (title || "meeting").replace(/[^\w\d\-. ]+/g, "").trim().replace(/\s+/g, "-");
  return `${safe.slice(0, 60)}-report.pdf`;
}
