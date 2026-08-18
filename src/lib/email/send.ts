// SendGrid transport. Matches how the DECYP form project sends mail, so the same
// account/sender can be reused.
//
// Config (set in Vercel — never committed):
//   SENDGRID_API_KEY  the API key
//   EMAIL_FROM        a VERIFIED sender on that SendGrid account, e.g.
//                     "OneMinute <noreply@yourdomain>". SendGrid rejects any
//                     From address that isn't verified.
//   EMAIL_REPLY_TO    optional; replies go here instead of the from address
//
// SERVER-ONLY: never import from a Client Component.

import sgMail from "@sendgrid/mail";

export function emailConfigured(): boolean {
  return !!process.env.SENDGRID_API_KEY && !!process.env.EMAIL_FROM;
}

export interface SendEmailInput {
  to: { email: string; name?: string }[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const key = process.env.SENDGRID_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) {
    throw new Error(
      "Email is not configured — set SENDGRID_API_KEY and EMAIL_FROM in the environment."
    );
  }
  if (input.to.length === 0) throw new Error("No recipients selected.");

  sgMail.setApiKey(key);

  // Personalizations with one entry per recipient means each person gets their
  // own copy — nobody sees the rest of the list, which matters when the
  // recipients are external stakeholders from different organisations.
  await sgMail.send({
    from,
    replyTo: process.env.EMAIL_REPLY_TO || undefined,
    subject: input.subject,
    html: input.html,
    text: input.text || stripHtml(input.html),
    personalizations: input.to.map((r) => ({
      to: [{ email: r.email, name: r.name }]
    }))
  });
}

// A plain-text fallback for clients that refuse HTML.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|h1|h2|h3|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
