// Tells people that work was assigned to them.
//
// Assignment was previously invisible to the assignee: roster people are not
// login accounts, so they never see the board or the dashboard. An item could be
// tracked perfectly and its owner never know it existed. This closes that loop.
//
// One email per person, listing only their own items.
//
// SERVER-ONLY.

import { db } from "@/lib/db";

const TYPE_LABEL: Record<string, string> = {
  Note: "Note",
  Todo: "To-Do",
  Action: "Action",
  Devops: "Devops"
};

// Statuses that mean "no longer needs doing" — nobody wants an email about work
// that was closed in the same meeting.
const DONE = ["Completed", "Cancelled"];

export interface AssignedItem {
  title: string;
  description: string | null;
  type: string;
  due: string | null;
}

export interface AssigneeGroup {
  name: string;
  email: string;
  items: AssignedItem[];
}

export interface AssigneeNotification {
  meetingTitle: string;
  projectName: string;
  when: string;
  groups: AssigneeGroup[];
  // People with items here whose address cannot receive mail. Surfaced rather
  // than silently skipped: the fix is to give them a real address, and nobody
  // would ever discover that from a send that quietly did nothing.
  unreachable: { name: string; reason: string }[];
}

// Roster people are seeded with placeholder addresses like
// "rob.stoneman@3tt.roster.local". `.local` is reserved (RFC 6762) and never
// routes, so sending there bounces or silently fails.
function deliverable(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return false;
  const domain = e.split("@")[1] ?? "";
  if (domain.endsWith(".local") || domain === "localhost") return false;
  if (domain.endsWith(".invalid") || domain.endsWith(".example")) return false;
  return true;
}

export async function loadAssigneeNotifications(
  orgId: string,
  meetingId: string
): Promise<AssigneeNotification | null> {
  const meeting = await db.meeting.findFirst({
    where: { id: meetingId, orgId },
    select: {
      title: true,
      meetingDate: true,
      project: { select: { name: true } },
      minutes: {
        where: {
          assignedToUserId: { not: null },
          status: { notIn: DONE as never[] }
        },
        orderBy: { createdAt: "asc" },
        select: {
          title: true,
          description: true,
          type: true,
          dueDate: true,
          parentMinuteId: true,
          assignedTo: { select: { id: true, displayName: true, email: true } }
        }
      }
    }
  });
  if (!meeting) return null;

  // An update entry carries the note, not the item's identity — use the thread
  // root's title so the email names the item the person actually owns.
  const rootIds = [
    ...new Set(meeting.minutes.filter((m) => m.parentMinuteId).map((m) => m.parentMinuteId!))
  ];
  const roots = rootIds.length
    ? await db.minute.findMany({
        where: { orgId, id: { in: rootIds } },
        select: { id: true, title: true, type: true }
      })
    : [];
  const rootById = new Map(roots.map((r) => [r.id, r]));

  const byPerson = new Map<string, AssigneeGroup>();
  const unreachable = new Map<string, { name: string; reason: string }>();
  const seen = new Set<string>(); // person+title, so a thread isn't listed twice

  for (const m of meeting.minutes) {
    const who = m.assignedTo;
    if (!who) continue;
    if (!deliverable(who.email)) {
      unreachable.set(who.id, {
        name: who.displayName,
        reason: who.email ? "no real email address on file" : "no email address"
      });
      continue;
    }

    const root = m.parentMinuteId ? rootById.get(m.parentMinuteId) : undefined;
    const title = root?.title ?? m.title;
    const key = `${who.id}::${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const group =
      byPerson.get(who.id) ??
      ({ name: who.displayName, email: who.email, items: [] } as AssigneeGroup);

    group.items.push({
      title,
      description: m.description,
      type: TYPE_LABEL[root?.type ?? m.type] ?? "Note",
      due: m.dueDate
        ? m.dueDate.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
        : null
    });
    byPerson.set(who.id, group);
  }

  return {
    meetingTitle: meeting.title,
    projectName: meeting.project.name,
    when: meeting.meetingDate.toLocaleDateString("en-AU", {
      year: "numeric",
      month: "long",
      day: "numeric"
    }),
    groups: [...byPerson.values()].filter((g) => g.items.length > 0),
    unreachable: [...unreachable.values()]
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The email one person receives — only their own items. */
export function buildAssigneeEmail(
  n: AssigneeNotification,
  group: AssigneeGroup,
  note: string
): { subject: string; html: string } {
  const count = group.items.length;
  const rows = group.items
    .map(
      (it) => `
      <tr><td style="padding:0 0 10px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid #059669;background:#f8fafc;border-radius:4px;">
          <tr><td style="padding:10px 12px;">
            <div>
              <span style="display:inline-block;background:#e2e8f0;color:#334155;border-radius:3px;padding:1px 6px;font-size:11px;font-weight:600;">${esc(it.type)}</span>
              <span style="font-weight:600;color:#1e293b;margin-left:6px;">${esc(it.title)}</span>
            </div>
            ${it.description ? `<div style="color:#475569;font-size:14px;line-height:1.5;margin-top:5px;">${esc(it.description)}</div>` : ""}
            ${it.due ? `<div style="margin-top:6px;font-size:12px;color:#b45309;">Due ${esc(it.due)}</div>` : ""}
          </td></tr>
        </table>
      </td></tr>`
    )
    .join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:8px;padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
        <tr><td>
          <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#2563eb;">${esc(n.projectName)}</div>
          <h1 style="margin:6px 0 4px 0;font-size:20px;color:#0f172a;">
            ${count} item${count === 1 ? "" : "s"} for you
          </h1>
          <div style="color:#64748b;font-size:14px;">
            From ${esc(n.meetingTitle)} &middot; ${esc(n.when)}
          </div>
        </td></tr>

        ${
          note.trim()
            ? `<tr><td style="padding-top:16px;"><div style="background:#eff6ff;border-left:3px solid #2563eb;border-radius:4px;padding:12px;color:#1e3a8a;font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(note.trim())}</div></td></tr>`
            : ""
        }

        <tr><td style="padding-top:18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr>

        <tr><td style="padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">
          Sent from OneMinute because these were assigned to you in this meeting.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return {
    subject: `${count} item${count === 1 ? "" : "s"} for you — ${n.meetingTitle}`,
    html
  };
}
