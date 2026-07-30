import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getWorkItemDetail, devopsConfigured } from "@/lib/devops";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireUser();
    if (!devopsConfigured()) {
      return NextResponse.json({ error: "DevOps is not connected" }, { status: 400 });
    }
    const { id } = await params;
    const wid = parseInt(id, 10);
    if (isNaN(wid)) {
      return NextResponse.json({ error: "invalid work item id" }, { status: 400 });
    }
    const detail = await getWorkItemDetail(wid);
    return NextResponse.json(detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    if (msg === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    console.error("devops workitem error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
