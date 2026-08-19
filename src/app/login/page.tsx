import { Suspense } from "react";
import { oidcConfigured } from "@/lib/oidc";

export const metadata = { title: "Sign in — OneMinute" };
export const dynamic = "force-dynamic";

// Sign-in is now a single button: the identity provider owns credentials, MFA
// and password policy, so there is no form here to get wrong.
export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const configured = oidcConfigured();
  const href = next ? `/api/auth/login?next=${encodeURIComponent(next)}` : "/api/auth/login";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-6">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-1 inline-block rounded bg-gradient-to-r from-brand-blue to-brand-purple px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-white">
          OneMinute
        </div>
        <h1 className="mb-6 text-2xl font-bold text-slate-800">Sign in</h1>

        {error && (
          <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <Suspense fallback={null}>
          {configured ? (
            <a
              href={href}
              className="block w-full rounded bg-gradient-to-r from-brand-blue to-brand-purple px-4 py-2.5 text-center font-medium text-white"
            >
              Sign in with your work account
            </a>
          ) : (
            <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              <div className="font-semibold">Sign-in is not configured</div>
              <p className="mt-1">
                Set <b>OIDC_ISSUER</b>, <b>OIDC_CLIENT_ID</b>, <b>OIDC_CLIENT_SECRET</b> and{" "}
                <b>AUTH_SECRET</b> in the environment, then redeploy.
              </p>
            </div>
          )}
        </Suspense>

        <p className="mt-6 text-xs text-slate-400">
          Access is managed by your organisation&apos;s identity provider.
        </p>
      </div>
    </main>
  );
}
