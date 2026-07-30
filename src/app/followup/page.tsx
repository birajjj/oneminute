import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadFollowUpData } from "@/lib/followup";
import { devopsConfigured } from "@/lib/devops";
import AppShell from "@/components/AppShell";
import FollowUpClient from "./FollowUpClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Follow-up Meeting" };

export default async function FollowUpPage({
  searchParams
}: {
  searchParams: Promise<{ parent?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/browse");

  const { parent } = await searchParams;
  if (!parent) redirect("/browse");

  const data = await loadFollowUpData(user.orgId, parent);
  if (!data) redirect("/browse");

  const [members, meetings, projects] = await Promise.all([
    db.user.findMany({
      where: { orgId: user.orgId, isRoster: true },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true }
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
    db.project.findMany({
      where: { orgId: user.orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    })
  ]);

  const shellMeetings = meetings.map((m) => ({
    id: m.id,
    title: m.title,
    date: m.meetingDate.toISOString(),
    projectId: m.project.id,
    projectName: m.project.name
  }));

  const devopsBaseUrl = (process.env.DEVOPS_API_URL ?? "").replace(/\/+$/, "");

  return (
    <AppShell meetings={shellMeetings} projects={projects} userName={user.displayName}>
      <FollowUpClient data={data} members={members} devopsBaseUrl={devopsBaseUrl} devopsEnabled={devopsConfigured()} />
    </AppShell>
  );
}
