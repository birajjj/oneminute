import { db } from "@/lib/db";
import { activeProvider } from "@/lib/email/send";

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

  const mailProvider = activeProvider();
  const envRows = [
    { name: "EMAIL_FROM", set: !!process.env.EMAIL_FROM },
    { name: "SENDGRID_API_KEY", set: !!process.env.SENDGRID_API_KEY },
    { name: "SMTP_HOST", set: !!process.env.SMTP_HOST },
    { name: "SMTP_USER", set: !!process.env.SMTP_USER },
    { name: "SMTP_PASS", set: !!process.env.SMTP_PASS },
    { name: "EMAIL_REPLY_TO", set: !!process.env.EMAIL_REPLY_TO }
  ];

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

      {/* Which mail transport the env vars currently select. Reports only
          whether each variable is SET — never its value. */}
      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h2 className="mb-4 text-xl font-bold">Email</h2>
        {mailProvider ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            <div className="font-semibold">
              Configured — sending via {mailProvider === "sendgrid" ? "SendGrid" : "SMTP"}
            </div>
            <div className="mt-1">Reports can be emailed to stakeholders.</div>
          </div>
        ) : (
          <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <div className="font-semibold">Not configured — sending is disabled</div>
            <div className="mt-1">
              Set <b>EMAIL_FROM</b> plus either <b>SENDGRID_API_KEY</b>, or all of{" "}
              <b>SMTP_HOST</b> / <b>SMTP_USER</b> / <b>SMTP_PASS</b>. Environment changes only take
              effect after a redeploy.
            </div>
          </div>
        )}
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500">
              <th className="py-2 font-normal">Variable</th>
              <th className="py-2 text-right font-normal">Set?</th>
            </tr>
          </thead>
          <tbody>
            {envRows.map((r) => (
              <tr key={r.name} className="border-b border-slate-100">
                <td className="py-2 font-mono">{r.name}</td>
                <td className={`py-2 text-right font-semibold ${r.set ? "text-emerald-700" : "text-slate-400"}`}>
                  {r.set ? "yes" : "no"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="pt-4 text-xs text-slate-500">
          Values are never shown here — only whether each variable exists.
        </p>
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
