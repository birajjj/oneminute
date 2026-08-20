import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { loadAssigneeNotifications, buildAssigneeEmail } from "@/lib/email/assignee-notify";
import { sendEmail, emailConfigured } from "@/lib/email/send";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET: who WOULD be emailed, and about how many items. Lets the UI name the
// recipients before anything is sent — nobody should be surprised by an email
// going out on their behalf.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const n = await loadAssigneeNotifications(user.orgId, id);
    if (!n) return NextResponse.json({ error: "meeting not found" }, { status: 404 });

    return NextResponse.json({
      configured: emailConfigured(),
      recipients: n.groups.map((g) => ({ name: g.name, email: g.email, items: g.items.length })),
      unreachable: n.unreachable
    });
  } catch (err) {
    return fail(err);
  }
}

const BodySchema = z.object({
  note: z.string().optional().default(""),
  // Limit to specific addresses; omit to notify everyone with items.
  only: z.array(z.string()).optional()
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    const note = parsed.success ? parsed.data.note : "";
    const only = parsed.success ? parsed.data.only : undefined;

    const user = await requireUser();
    const n = await loadAssigneeNotifications(user.orgId, id);
    if (!n) return NextResponse.json({ error: "meeting not found" }, { status: 404 });

    const groups = only?.length
      ? n.groups.filter((g) => only.includes(g.email))
      : n.groups;

    if (groups.length === 0) {
      return NextResponse.json({ sent: 0, recipients: [] });
    }

    if (!emailConfigured()) {
      return NextResponse.json(
        {
          error:
            "Email is not configured yet. Set EMAIL_FROM plus either SENDGRID_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS. Then redeploy."
        },
        { status: 503 }
      );
    }

    // One message each, containing only that person's items — nobody sees
    // anyone else's workload, and a failure for one does not stop the rest.
    const sentTo: string[] = [];
    const failed: string[] = [];
    for (const g of groups) {
      const { subject, html } = buildAssigneeEmail(n, g, note);
      try {
        await sendEmail({ to: [{ email: g.email, name: g.name }], subject, html });
        sentTo.push(g.email);
      } catch (e) {
        console.error("assignee notify failed for", g.email, e instanceof Error ? e.message : e);
        failed.push(g.email);
      }
    }

    return NextResponse.json({ sent: sentTo.length, recipients: sentTo, failed });
  } catch (err) {
    return fail(err);
  }
}

function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : "unknown error";
  if (msg === "UNAUTHENTICATED") {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  console.error("notify assignees error:", msg);
  return NextResponse.json({ error: msg }, { status: 500 });
}
