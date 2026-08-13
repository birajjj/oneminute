import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadProjectReport } from "@/lib/project-report";
import ProjectReportClient from "./ProjectReportClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project Status Report" };

export default async function ProjectReportPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/report/project/${id}`);

  const project = await db.project.findFirst({
    where: { id, orgId: user.orgId },
    select: { id: true, name: true }
  });
  if (!project) redirect("/browse");

  const { items, meta } = await loadProjectReport(user.orgId, project.id);

  return (
    <ProjectReportClient
      projectId={project.id}
      projectName={project.name}
      items={items}
      meta={meta}
    />
  );
}
