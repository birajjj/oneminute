"use client";

import { useEffect, useState } from "react";
import { suggestMissingChunked, type MissedSuggestion } from "@/lib/chunk-analyze";
import {
  readGapsPayload,
  pushAccepted,
  type GapsPayload
} from "@/lib/gaps-handoff";

// Side-by-side: what you wrote during the meeting vs what the AI thinks is
// missing from it. Opens in its own tab so the meeting page (and its recording)
// is never disturbed; accepted items are pushed back to that tab live.
export default function GapsClient() {
  const [payload, setPayload] = useState<GapsPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [suggestions, setSuggestions] = useState<MissedSuggestion[] | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");

  useEffect(() => {
    const p = readGapsPayload();
    setPayload(p);
    if (p?.transcript?.trim()) void run(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(p: GapsPayload) {
    setBusy(true);
    setError("");
    setAccepted(new Set());
    setProgress(null);
    try {
      const out = await suggestMissingChunked(p.transcript, p.captured, p.areas, p.projectId, (x) =>
        setProgress({ done: x.done, total: x.total })
      );
      setSuggestions(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not compare against the transcript");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  if (!payload) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <h1 className="text-xl font-bold text-slate-800">AI Recommendation</h1>
        <p className="mt-2 rounded border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
          Nothing to compare yet. Open this from a meeting page using{" "}
          <b>✨ AI Recommendation</b> — it sends the minutes you&apos;ve written plus the
          transcript over to this page.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold text-slate-800">AI Recommendation</h1>
          <p className="truncate text-xs text-slate-500">
            {payload.meetingTitle || "Untitled meeting"} · AI comparing your minutes with the transcript
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            onClick={() => run(payload)}
            disabled={busy || !payload.transcript.trim()}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
          >
            {busy
              ? progress && progress.total > 1
                ? `Checking… ${Math.min(progress.done + 1, progress.total)}/${progress.total}`
                : "Checking…"
              : "↻ Re-check"}
          </button>
          <button
            onClick={() => window.close()}
            className="rounded bg-brand-blue px-3 py-1.5 text-sm font-medium text-white"
            title="Close this tab and go back to your meeting"
          >
            Back to meeting
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">
        {error && (
          <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* What the human wrote — the standard everything is measured against */}
          <section>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-600">
              Your minutes
              <span className="ml-2 text-xs font-normal normal-case text-slate-400">
                {payload.captured.length} written during the meeting
              </span>
            </h2>
            {payload.captured.length === 0 ? (
              <p className="rounded border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-400">
                You haven&apos;t written any minutes yet — everything below will look missing.
              </p>
            ) : (
              <ul className="space-y-2">
                {payload.captured.map((c, i) => (
                  <li key={i} className="rounded border border-slate-200 bg-white p-3 text-sm">
                    <div className="flex items-baseline gap-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                        {c.type}
                      </span>
                      <span className="font-medium text-slate-800">{c.title || "(untitled)"}</span>
                    </div>
                    {c.description && <p className="mt-1 text-slate-600">{c.description}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* What the AI believes is missing from them */}
          <section>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-amber-700">
              AI recommends adding
              {suggestions && (
                <span className="ml-2 text-xs font-normal normal-case text-slate-400">
                  {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}
                </span>
              )}
            </h2>

            {busy && (
              <p className="rounded border border-slate-200 bg-white p-6 text-sm text-slate-500">
                Reading the transcript against your minutes…
              </p>
            )}

            {!busy && suggestions !== null && suggestions.length === 0 && (
              <p className="rounded border border-emerald-300 bg-emerald-50 p-6 text-sm text-emerald-700">
                ✓ Nothing obvious missing — your minutes cover what was discussed.
              </p>
            )}

            {!busy && suggestions !== null && suggestions.length > 0 && (
              <ul className="space-y-2">
                {suggestions.map((s, i) => {
                  const isAccepted = accepted.has(i);
                  return (
                    <li
                      key={i}
                      className={`rounded border p-3 text-sm ${
                        isAccepted ? "border-emerald-300 bg-emerald-50" : "border-amber-200 bg-white"
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="flex items-baseline gap-2">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                            {s.minuteType}
                          </span>
                          <span className="font-medium text-slate-800">{s.title}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                            {s.area}
                          </span>
                          {isAccepted ? (
                            <span className="text-xs font-medium text-emerald-700">
                              Added ✓
                            </span>
                          ) : (
                            <button
                              onClick={async () => {
                                if (payload.meetingId) {
                                  // Already-saved meeting: write it straight in.
                                  try {
                                    const res = await fetch(
                                      `/api/meetings/${payload.meetingId}/minutes`,
                                      {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                          area: s.area,
                                          title: s.title,
                                          description: s.description,
                                          type: s.minuteType
                                        })
                                      }
                                    );
                                    if (!res.ok) throw new Error("save failed");
                                  } catch {
                                    setError("Could not add that minute — try again.");
                                    return;
                                  }
                                } else {
                                  pushAccepted({
                                    title: s.title,
                                    description: s.description,
                                    minuteType: s.minuteType,
                                    area: s.area
                                  });
                                }
                                setAccepted((prev) => new Set(prev).add(i));
                              }}
                              className="rounded bg-brand-blue px-2 py-1 text-xs font-medium text-white"
                              title="Add this to the minutes in your meeting tab"
                            >
                              + Add to my minutes
                            </button>
                          )}
                        </span>
                      </div>
                      {s.description && <p className="mt-1 text-slate-600">{s.description}</p>}
                      {s.reason && (
                        <p className="mt-1 text-xs italic text-slate-400">Why: {s.reason}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <p className="mt-6 text-xs text-slate-400">
          Anything you add appears in the meeting tab straight away — switch back there to edit it,
          then Approve &amp; Commit as usual. Nothing here is saved on its own.
        </p>
      </main>
    </div>
  );
}
