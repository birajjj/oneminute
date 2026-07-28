import { db } from "@/lib/db";

// Force dynamic — this page hits the DB on every request, no caching.
export const dynamic = "force-dynamic";

export default async function StatusPage() {
  let orgCount = 0;
  let projectCount = 0;
  let meetingCount = 0;
  let minuteCount = 0;
  let dbError: string | null = null;

  try {
    [orgCount, projectCount, meetingCount, minuteCount] = await Promise.all([
      db.org.count(),
      db.project.count(),
      db.meeting.count(),
      db.minute.count()
    ]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : "unknown error";
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-4 inline-block rounded bg-gradient-to-r from-brand-blue to-brand-purple px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-white">
          System Status
        </div>
        <h1 className="mb-6 text-3xl font-bold">Database Check</h1>

        {dbError ? (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <div className="font-semibold">Database not reachable</div>
            <div className="mt-1 font-mono text-xs">{dbError}</div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-600">Live row counts from Supabase:</p>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 font-normal">Table</th>
                  <th className="py-2 text-right font-normal">Rows</th>
                </tr>
              </thead>
              <tbody>
                <Row name="orgs" count={orgCount} />
                <Row name="projects" count={projectCount} />
                <Row name="meetings" count={meetingCount} />
                <Row name="minutes" count={minuteCount} />
              </tbody>
            </table>
            <p className="pt-4 text-xs text-slate-500">
              If this loaded without an error, the Next.js app is talking to Supabase Postgres via Prisma.
              All zeros is expected — no data yet.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function Row({ name, count }: { name: string; count: number }) {
  return (
    <tr className="border-b border-slate-100">
      <td className="py-2 font-mono">{name}</td>
      <td className="py-2 text-right font-semibold">{count}</td>
    </tr>
  );
}
