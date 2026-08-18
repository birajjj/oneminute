// Builds the stakeholder email body for a meeting report.
//
// Rendered as inline-styled HTML rather than a link, because stakeholders are
// external and cannot sign in to view the report page. Email clients strip
// <style> blocks and most modern CSS, so every rule here is inline and the
// layout stays simple.
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
const FLAGS = ["Decision", "Scope", "Governance"];

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ReportEmail {
  subject: string;
  html: string;
  meetingTitle: string;
}

export async function buildReportEmail(
  orgId: string,
  meetingId: string,
  note: string
): Promise<ReportEmail | null> {
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
  const rootIds = [...new Set(meeting.minutes.filter((m) => m.parentMinuteId).map((m) => m.parentMinuteId!))];
  const roots = rootIds.length
    ? await db.minute.findMany({
        where: { orgId, id: { in: rootIds } },
        select: { id: true, title: true, type: true, area: true }
      })
    : [];
  const rootById = new Map(roots.map((r) => [r.id, r]));

  interface Row {
    title: string;
    type: string;
    status: string;
    note: string | null;
    area: string;
    owner: string | null;
    due: Date | null;
    tags: string[];
  }
  const rows: Row[] = meeting.minutes.map((m) => {
    const root = m.parentMinuteId ? rootById.get(m.parentMinuteId) : undefined;
    return {
      title: root?.title ?? m.title,
      type: TYPE_LABEL[root?.type ?? m.type] ?? "Note",
      status: STATUS_LABEL[m.status] ?? m.status,
      note: m.description,
      area: (root?.area || m.area || "General").trim(),
      owner: m.assignedTo?.displayName ?? null,
      due: m.dueDate,
      tags: m.tags ?? []
    };
  });

  // Same order as the on-screen report: commitments, then outcomes, then
  // background. Each row is claimed once.
  const actions = rows.filter((r) => ACTION_TYPES.includes(r.type));
  const rest = rows.filter((r) => !ACTION_TYPES.includes(r.type));
  const decisions = rest.filter((r) => r.tags.some((t) => FLAGS.includes(t)));
  const notes = rest.filter((r) => !r.tags.some((t) => FLAGS.includes(t)));

  const when = meeting.meetingDate.toLocaleDateString("en-AU", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const section = (heading: string, colour: string, list: Row[]) => {
    if (list.length === 0) return "";
    const items = list
      .map((r) => {
        const meta = [
          r.owner ? esc(r.owner) : "",
          r.due ? `due ${r.due.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}` : "",
          esc(r.area)
        ]
          .filter(Boolean)
          .join(" &middot; ");
        const flags = r.tags
          .filter((t) => FLAGS.includes(t))
          .map(
            (t) =>
              `<span style="display:inline-block;background:#ede9fe;color:#6d28d9;border-radius:9999px;padding:1px 7px;font-size:11px;margin-right:4px;">${esc(t)}</span>`
          )
          .join("");
        return `
          <tr><td style="padding:0 0 10px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid ${colour};background:#f8fafc;border-radius:4px;">
              <tr><td style="padding:10px 12px;">
                <div>
                  <span style="display:inline-block;background:#e2e8f0;color:#334155;border-radius:3px;padding:1px 6px;font-size:11px;font-weight:600;">${esc(r.type)}</span>
                  <span style="font-weight:600;color:#1e293b;margin-left:6px;">${esc(r.title)}</span>
                  <span style="color:#64748b;font-size:12px;margin-left:6px;">${esc(r.status)}</span>
                </div>
                ${r.note ? `<div style="color:#475569;font-size:14px;line-height:1.5;margin-top:5px;">${esc(r.note)}</div>` : ""}
                ${flags || meta ? `<div style="margin-top:6px;font-size:12px;color:#94a3b8;">${flags}${meta}</div>` : ""}
              </td></tr>
            </table>
          </td></tr>`;
      })
      .join("");
    return `
      <tr><td style="padding:18px 0 6px 0;">
        <div style="font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${colour};">
          ${esc(heading)} <span style="color:#94a3b8;font-weight:400;">${list.length}</span>
        </div>
      </td></tr>
      <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table></td></tr>`;
  };

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#ffffff;border-radius:8px;padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
        <tr><td>
          <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#2563eb;">${esc(meeting.project.name)}</div>
          <h1 style="margin:6px 0 4px 0;font-size:22px;color:#0f172a;">${esc(meeting.title)}</h1>
          <div style="color:#64748b;font-size:14px;">${esc(when)}</div>
        </td></tr>
        ${
          note.trim()
            ? `<tr><td style="padding-top:16px;"><div style="background:#eff6ff;border-left:3px solid #2563eb;border-radius:4px;padding:12px;color:#1e3a8a;font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(note.trim())}</div></td></tr>`
            : ""
        }
        ${
          meeting.description
            ? `<tr><td style="padding-top:18px;">
                 <div style="font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#64748b;">Summary</div>
                 <div style="color:#334155;font-size:14px;line-height:1.6;margin-top:6px;">${esc(meeting.description)}</div>
               </td></tr>`
            : ""
        }
        ${section("Actions, to-dos &amp; devops", "#059669", actions)}
        ${section("Decisions, scope &amp; governance", "#7c3aed", decisions)}
        ${section("Notes &amp; discussion", "#64748b", notes)}
        <tr><td style="padding-top:22px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">
          Sent from OneMinute &middot; ${esc(meeting.project.name)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return {
    subject: `${meeting.title} — meeting report`,
    html,
    meetingTitle: meeting.title
  };
}
