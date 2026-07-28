"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/browse";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const supabase = createClient();

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setInfo("");
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}` }
        });
        if (error) throw error;
        setInfo("Check your email to confirm your account, then sign in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(next);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithMicrosoft() {
    setError("");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "azure",
      options: {
        scopes: "email openid profile",
        redirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`
      }
    });
    if (error) setError(error.message);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-2xl font-bold">
          {mode === "login" ? "Sign in" : "Create account"}
        </h1>
        <p className="mb-6 text-sm text-slate-500">OneMinute Cloud</p>

        <button
          onClick={signInWithMicrosoft}
          className="mb-4 flex w-full items-center justify-center gap-2 rounded border border-slate-300 py-2 text-sm font-medium hover:bg-slate-50"
        >
          <span className="text-blue-600">▦</span> Continue with Microsoft
        </button>

        <div className="my-4 flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
        </div>

        <form onSubmit={submitEmail} className="space-y-3">
          <input
            type="email"
            required
            placeholder="you@3tt.com.au"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="Password (min 6 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-gradient-to-r from-brand-pink to-brand-purple py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "…" : mode === "login" ? "Sign in" : "Sign up"}
          </button>
        </form>

        {error && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {info && <p className="mt-3 rounded bg-emerald-50 p-2 text-sm text-emerald-700">{info}</p>}

        <p className="mt-6 text-center text-sm text-slate-500">
          {mode === "login" ? (
            <>No account? <a href="/signup" className="text-brand-purple underline">Sign up</a></>
          ) : (
            <>Already have an account? <a href="/login" className="text-brand-purple underline">Sign in</a></>
          )}
        </p>
      </div>
    </main>
  );
}
