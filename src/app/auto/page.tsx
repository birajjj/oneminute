import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { devopsConfigured } from "@/lib/devops";
import AppShell from "@/components/AppShell";
import AutoModeClient from "./AutoModeClient";

export const metadata = { title: "Auto Capture — Meeting Minutes" };
export const dynamic = "force-dynamic";

export default async function AutoPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/auto");

  const [projects, meetings, members] = await Promise.all([
    db.project.findMany({
      where: { orgId: user.orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    }),
    db.meeting.findMany({
      where: { orgId: user.orgId },
      orderBy: { meetingDate: "desc" },
      select: {
        id: true,
        title: true,
        meetingDate: true,
        project: { select: { id: true, name: true } }
      }
    }),
    db.user.findMany({
      where: { orgId: user.orgId, isRoster: true },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true }
    })
  ]);

  const shellMeetings = meetings.map((m) => ({
    id: m.id,
    title: m.title,
    date: m.meetingDate.toISOString(),
    projectId: m.project.id,
    projectName: m.project.name
  }));

  return (
    <AppShell meetings={shellMeetings} projects={projects} userName={user.displayName}>
      <div className="mb-6">
        <span className="mb-2 inline-block rounded bg-gradient-to-r from-brand-pink to-brand-purple px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-white">
          Auto
        </span>
        <h1 className="text-2xl font-bold">Fully-automatic Meeting Capture</h1>
        <p className="text-sm text-slate-600">
          Record → AI decides project, meeting, and minutes → you review → save.
          Nothing is written until you click Approve &amp; Commit.
        </p>
      </div>
      <AutoModeClient members={members} projects={projects} meetings={shellMeetings} devopsEnabled={devopsConfigured()} />
    </AppShell>
  );
}
