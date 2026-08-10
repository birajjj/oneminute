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
  Resolved: "Resolved",
  Completed: "Closed",
  Cancelled: "Cancelled"
};

export default async function BrowsePage({
  searchParams
}: {
  searchParams: Promise<{ meeting?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/browse");

  const { meeting: initialMeetingId } = await searchParams;

  const projects = await db.project.findMany({
    where: { orgId: user.orgId },
    orderBy: { name: "asc" },
    select: { id: true, name: true }
  });

  const members = await db.user.findMany({
    where: { orgId: user.orgId, isRoster: true },
    orderBy: { displayName: "asc" },
    select: { id: true, displayName: true }
  });

  const meetings = await db.meeting.findMany({
    where: { orgId: user.orgId },
    orderBy: { meetingDate: "desc" },
    include: {
      project: { select: { id: true, name: true } },
      areas: { select: { areaName: true } },
      // Metadata only — never load the file bytes into a list query.
      attachments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, fileName: true, contentType: true, size: true, createdAt: true }
      },
      minutes: {
        orderBy: [{ area: "asc" }, { createdAt: "asc" }],
        include: { assignedTo: { select: { displayName: true } } }
      }
    }
  });

  // Resolve follow-up parent meeting titles for display.
  const meetingById = new Map(meetings.map((m) => [m.id, m]));

  // raisedFromRootId lives only on a sub-item's ROOT, not on its later update
  // entries. Map each thread root -> its raisedFromRootId so every minute in the
  // thread can be nested under the item it was raised from, in ANY meeting.
  // Root -> its project, so a raised-from link is only ever honoured WITHIN one
  // project. A sub-item must never nest under — or surface — a minute from a
  // different project (which would leak another project's item into this view).
  const projectByRoot = new Map<string, string>();
  for (const m of meetings) {
    for (const mn of m.minutes) {
      if (!mn.parentMinuteId) projectByRoot.set(mn.id, m.project.id);
    }
  }

  const rootRaisedFrom = new Map<string, string | null>();
  // parent thread root -> the child (sub-item) roots raised under it, so a parent
  // card can always show its whole sub-tree (as-of the viewed meeting).
  const raisedChildrenOf: Record<string, string[]> = {};
  for (const m of meetings) {
    for (const mn of m.minutes) {
      if (!mn.parentMinuteId) {
        const parent = mn.raisedFromRootId;
        const sameProject = !!parent && projectByRoot.get(parent) === m.project.id;
        rootRaisedFrom.set(mn.id, sameProject ? parent : null);
        if (sameProject && parent) (raisedChildrenOf[parent] ??= []).push(mn.id);
      }
    }
  }

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
        isRoot: !mn.parentMinuteId,
        devopsItemId: mn.devopsItemId ?? null,
        assignedTo: mn.assignedTo?.displayName ?? null,
        tags: mn.tags ?? [],
        area: mn.area || "General"
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
      // Registered tabs on this meeting — so a manually-added empty tab persists.
      areaNames: m.areas.map((a) => a.areaName),
      attachments: m.attachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        contentType: a.contentType,
        size: a.size,
        createdAt: a.createdAt.toISOString()
      })),
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
          assignedTo: mn.assignedTo?.displayName ?? null,
          dueDate: mn.dueDate ? mn.dueDate.toISOString() : null,
          devopsItemId: mn.devopsItemId ?? null,
          tags: mn.tags ?? [],
          raisedFromRootId: mn.raisedFromRootId ?? null,
          // The raised-from of this minute's whole thread (so update entries in
          // later meetings nest under the same parent as the original sub-item).
          threadRaisedFrom: rootRaisedFrom.get(rootId) ?? null
        };
      })
    };
  });

  const shapedProjects: BrowseProject[] = projects.map((p) => ({
    id: p.id,
    name: p.name
  }));

  // Base URL for linking out to DevOps work items (blank if not configured).
  const devopsBaseUrl = (process.env.DEVOPS_API_URL ?? "").replace(/\/+$/, "");

  return (
    <BrowseClient
      meetings={shaped}
      projects={shapedProjects}
      threads={threads}
      raisedChildrenOf={raisedChildrenOf}
      members={members}
      userName={user.displayName}
      devopsBaseUrl={devopsBaseUrl}
      initialMeetingId={initialMeetingId ?? null}
    />
  );
}
