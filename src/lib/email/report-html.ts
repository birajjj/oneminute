// The covering email that carries the report PDF.
//
// The report itself is the attachment, so this body stays deliberately short: a
// greeting, the sender's note, and enough of a summary that the recipient knows
// what they are opening before they open it.
//
// Inline styles only — email clients strip <style> blocks.
//
// SERVER-ONLY.

import { loadReportContent, reportFileName, type ReportContent } from "./report-data";
import { renderReportPdf } from "./report-pdf";

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
  attachment: { filename: string; content: Buffer; contentType: string };
}

export async function buildReportEmail(
  orgId: string,
  meetingId: string,
  note: string
): Promise<ReportEmail | null> {
  const content = await loadReportContent(orgId, meetingId);
  if (!content) return null;

  const pdf = await renderReportPdf(content, note);

  const counts = [
    content.actions.length ? `${content.actions.length} action${content.actions.length === 1 ? "" : "s"}` : "",
    content.decisions.length ? `${content.decisions.length} decision${content.decisions.length === 1 ? "" : "s"}` : "",
    content.notes.length ? `${content.notes.length} note${content.notes.length === 1 ? "" : "s"}` : ""
  ]
    .filter(Boolean)
    .join(" · ");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
        <tr><td>
          <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#2563eb;">${esc(content.projectName)}</div>
          <h1 style="margin:6px 0 4px 0;font-size:20px;color:#0f172a;">${esc(content.meetingTitle)}</h1>
          <div style="color:#64748b;font-size:14px;">${esc(content.when)}</div>
        </td></tr>

        ${
          note.trim()
            ? `<tr><td style="padding-top:16px;"><div style="background:#eff6ff;border-left:3px solid #2563eb;border-radius:4px;padding:12px;color:#1e3a8a;font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(note.trim())}</div></td></tr>`
            : ""
        }

        <tr><td style="padding-top:18px;">
          <div style="color:#334155;font-size:14px;line-height:1.6;">
            The full meeting report is attached as a PDF.
          </div>
          ${
            counts
              ? `<div style="margin-top:8px;color:#64748b;font-size:13px;">It covers ${esc(counts)}.</div>`
              : ""
          }
        </td></tr>

        ${
          content.summary
            ? `<tr><td style="padding-top:18px;">
                 <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#64748b;">Summary</div>
                 <div style="color:#334155;font-size:14px;line-height:1.6;margin-top:6px;">${esc(content.summary)}</div>
               </td></tr>`
            : ""
        }

        <tr><td style="padding-top:22px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">
          Sent from OneMinute &middot; ${esc(content.projectName)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return {
    subject: `${content.meetingTitle} — meeting report`,
    html,
    meetingTitle: content.meetingTitle,
    attachment: {
      filename: reportFileName(content.meetingTitle, content.when),
      content: pdf,
      contentType: "application/pdf"
    }
  };
}

export type { ReportContent };
