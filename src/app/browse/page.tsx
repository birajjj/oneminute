import { db } from "@/lib/db";
import { currentOrgId } from "@/lib/dev-context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Browse — OneMinute Cloud" };

const TYPE_LABEL: Record<string, string> = {
  Note: "Note",
  Todo: "To-Do",
  Action: "Action",
  Devops: "Devops"
};

const STATUS_LABEL: Record<string, string> = {
  New: "New",
  Initiated: "Initiated",
  InProgress: "In Progress",
  Completed: "Completed",
  Cancelled: "Cancelled"
};

export default async function BrowsePage() {
  const orgId = currentOrgId();

  const projects = await db.project.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    include: {
      meetings: {
        orderBy: { meetingDate: "desc" },
        include: {
          minutes: { orderBy: [{ area: "asc" }, { createdAt: "asc" }] }
        }
      }
    }
  });

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Browse</h1>
        <a href="/auto" className="rounded bg-gradient-to-r from-brand-pink to-brand-purple px-3 py-1.5 text-sm font-medium text-white">
          + Capture a meeting
        </a>
      </div>

      {projects.length === 0 && (
        <p className="text-slate-500">No projects yet. Use Auto Mode to capture a meeting.</p>
      )}

      <div className="space-y-6">
        {projects.map((p) => (
          <section key={p.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-lg font-semibold">{p.name}</h2>

            {p.meetings.length === 0 && (
              <p className="text-sm text-slate-400">No meetings.</p>
            )}

            <div className="space-y-4">
              {p.meetings.map((m) => {
                const areas = groupByArea(m.minutes);
                return (
                  <div key={m.id} className="rounded border border-slate-200">
                    <div className="border-b border-slate-100 bg-slate-50 px-3 py-2">
                      <div className="font-medium">{m.title}</div>
                      <div className="text-xs text-slate-500">
                        {m.meetingDate.toISOString().slice(0, 10)}
                        {m.attendee ? ` · ${m.attendee}` : ""}
                        {m.parentMeetingIdRaw ? " · follow-up" : ""}
                      </div>
                      {m.description && (
                        <div className="mt-1 text-xs text-slate-600">{m.description}</div>
                      )}
                    </div>

                    <div className="p-3">
                      {Object.entries(areas).map(([area, minutes]) => (
                        <div key={area} className="mb-3 last:mb-0">
                          <div className="mb-1 inline-block rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                            {area}
                          </div>
                          <ul className="space-y-1">
                            {minutes.map((mn) => (
                              <li
                                key={mn.id}
                                className={`rounded border-l-4 p-2 text-sm ${
                                  mn.parentMinuteId
                                    ? "border-l-amber-500 bg-amber-50"
                                    : "border-l-brand-blue bg-blue-50"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{mn.title}</span>
                                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase text-slate-600">
                                    {TYPE_LABEL[mn.type] ?? mn.type}
                                  </span>
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                                    {STATUS_LABEL[mn.status] ?? mn.status}
                                  </span>
                                  {mn.isPersistent && (
                                    <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] text-purple-700">
                                      persists
                                    </span>
                                  )}
                                </div>
                                {mn.description && (
                                  <div className="mt-0.5 text-xs text-slate-600">{mn.description}</div>
                                )}
                                <div className="mt-0.5 text-[11px] text-slate-400">
                                  {mn.dueDate ? `Due ${mn.dueDate.toISOString().slice(0, 10)}` : ""}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

type MinuteRow = {
  id: string;
  area: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  isPersistent: boolean;
  parentMinuteId: string | null;
  dueDate: Date | null;
};

function groupByArea(minutes: MinuteRow[]): Record<string, MinuteRow[]> {
  const out: Record<string, MinuteRow[]> = {};
  for (const m of minutes) {
    const area = m.area || "General";
    (out[area] ??= []).push(m);
  }
  return out;
}
