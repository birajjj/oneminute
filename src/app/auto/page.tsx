import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import AutoModeClient from "./AutoModeClient";

export const metadata = { title: "Auto Mode — OneMinute Cloud" };
export const dynamic = "force-dynamic";

export default async function AutoPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/auto");

  return renderAuto();
}

function renderAuto() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
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
      <AutoModeClient />
    </main>
  );
}
