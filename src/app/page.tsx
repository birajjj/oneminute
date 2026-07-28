export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-4 inline-block rounded bg-gradient-to-r from-brand-pink to-brand-purple px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-white">
          Scaffold
        </div>
        <h1 className="mb-2 text-3xl font-bold">OneMinute Cloud</h1>
        <p className="mb-6 text-slate-600">
          If you can see this, the Next.js scaffold deployed successfully. Auth,
          database, and AI features are wired in the next step.
        </p>
        <ul className="space-y-1 text-sm text-slate-700">
          <li>✓ Next.js 16 (App Router) + TypeScript</li>
          <li>✓ Tailwind CSS</li>
          <li>✓ Prisma + Supabase Postgres (with RLS)</li>
          <li>… Microsoft SSO (next)</li>
          <li>… Gemini AI integration (next)</li>
        </ul>
        <p className="mt-6 flex gap-4 text-sm">
          <a href="/auto" className="font-semibold text-brand-pink underline">
            → Auto Mode (record a meeting)
          </a>
          <a href="/browse" className="font-semibold text-brand-blue underline">
            → Browse meetings &amp; minutes
          </a>
          <a href="/status" className="text-brand-purple underline">
            → Database status
          </a>
        </p>
      </div>
    </main>
  );
}
