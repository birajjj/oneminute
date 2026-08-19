// Outbound mail. Two transports, picked from whichever env vars are present, so
// the app can send through any mailbox you already have today and be switched to
// a corporate account later WITHOUT a code change — only env vars move.
//
//   SendGrid (preferred once available — matches the DECYP project):
//     SENDGRID_API_KEY   the API key
//
//   SMTP (works with Office 365, Gmail app passwords, or any SMTP host):
//     SMTP_HOST          e.g. smtp.office365.com / smtp.gmail.com
//     SMTP_PORT          587 (STARTTLS, default) or 465 (implicit TLS)
//     SMTP_USER          mailbox login
//     SMTP_PASS          password or app password
//
//   Both:
//     EMAIL_FROM         the sender, e.g. "OneMinute <noreply@yourdomain>".
//                        SendGrid requires this address to be VERIFIED; SMTP
//                        usually requires it to match SMTP_USER.
//     EMAIL_REPLY_TO     optional; replies go here instead
//
// SERVER-ONLY: never import from a Client Component.

export type EmailProvider = "sendgrid" | "smtp" | null;

/** Which transport is usable right now, or null if none is configured. */
export function activeProvider(): EmailProvider {
  if (!process.env.EMAIL_FROM) return null;
  if (process.env.SENDGRID_API_KEY) return "sendgrid";
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return "smtp";
  return null;
}

export function emailConfigured(): boolean {
  return activeProvider() !== null;
}

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendEmailInput {
  to: { email: string; name?: string }[];
  subject: string;
  html: string;
  text?: string;
  attachments?: Attachment[];
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const provider = activeProvider();
  const from = process.env.EMAIL_FROM;
  if (!provider || !from) {
    throw new Error(
      "Email is not configured — set EMAIL_FROM plus either SENDGRID_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS."
    );
  }
  if (input.to.length === 0) throw new Error("No recipients selected.");

  const text = input.text || stripHtml(input.html);
  const replyTo = process.env.EMAIL_REPLY_TO || undefined;

  if (provider === "sendgrid") {
    const sgMail = (await import("@sendgrid/mail")).default;
    sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
    // One personalization per recipient: each person gets their own copy and
    // never sees the rest of the list (they are external stakeholders).
    await sgMail.send({
      from,
      replyTo,
      subject: input.subject,
      html: input.html,
      text,
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        type: a.contentType,
        disposition: "attachment",
        content: a.content.toString("base64")
      })),
      personalizations: input.to.map((r) => ({ to: [{ email: r.email, name: r.name }] }))
    });
    return;
  }

  const nodemailer = (await import("nodemailer")).default;
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 upgrades via STARTTLS
    auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! }
  });

  // Sent one message per recipient, for the same privacy reason as above.
  for (const r of input.to) {
    await transport.sendMail({
      from,
      to: r.name ? `${r.name} <${r.email}>` : r.email,
      replyTo,
      subject: input.subject,
      html: input.html,
      text,
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType
      }))
    });
  }
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
