import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { devopsConfigured, listProjects } from "@/lib/devops";

// Lists DevOps projects for the "Create work item" dropdown.
export async function GET() {
  try {
    await requireUser();

    if (!devopsConfigured()) {
      return NextResponse.json({ configured: false, projects: [] });
    }

    const projects = await listProjects();
    return NextResponse.json({ configured: true, projects });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("devops/projects error:", msg);
    return NextResponse.json({ configured: false, projects: [], error: msg }, { status: 200 });
  }
}
