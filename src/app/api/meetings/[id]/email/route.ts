import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildReportEmail } from "@/lib/email/report-html";
import { sendEmail, emailConfigured } from "@/lib/email/send";

export const runtime = "nodejs";
export const maxDuration = 60;

// Emails a meeting report to selected stakeholders. Recipients are resolved
// SERVER-SIDE from ids scoped to this org and this meeting's project, so a
// request can never be made to send to an arbitrary address.
const BodySchema = z.object({
  stakeholderIds: z.array(z.string()).min(1),
  subject: z.string().trim().optional(),
  note: z.string().optional().default(""),
  // Renders the email and returns it WITHOUT sending — used to preview first.
  preview: z.boolean().optional().default(false)
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Select at least one stakeholder." }, { status: 400 });
    }
    const user = await requireUser();

    const meeting = await db.meeting.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true, projectId: true }
    });
    if (!meeting) return NextResponse.json({ error: "meeting not found" }, { status: 404 });

    // Only stakeholders of THIS meeting's project, in THIS org.
    const recipients = await db.stakeholder.findMany({
      where: {
        id: { in: parsed.data.stakeholderIds },
        orgId: user.orgId,
        projectId: meeting.projectId
      },
      select: { name: true, email: true }
    });
    if (recipients.length === 0) {
      return NextResponse.json({ error: "No valid recipients." }, { status: 400 });
    }

    const built = await buildReportEmail(user.orgId, id, parsed.data.note);
    if (!built) return NextResponse.json({ error: "meeting not found" }, { status: 404 });

    const subject = parsed.data.subject?.trim() || built.subject;

    if (parsed.data.preview) {
      // Return the PDF itself — the point of previewing is to check the
      // attachment recipients will actually open.
      return new NextResponse(new Uint8Array(built.attachment.content), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${built.attachment.filename}"`
        }
      });
    }

    if (!emailConfigured()) {
      return NextResponse.json(
        {
          error:
            "Email is not configured yet. Set EMAIL_FROM plus either SENDGRID_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS to send through an existing mailbox. Then redeploy."
        },
        { status: 503 }
      );
    }

    await sendEmail({
      to: recipients.map((r) => ({ email: r.email, name: r.name })),
      subject,
      html: built.html,
      attachments: [built.attachment]
    });

    return NextResponse.json({ sent: recipients.length, recipients: recipients.map((r) => r.email) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("report email error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
