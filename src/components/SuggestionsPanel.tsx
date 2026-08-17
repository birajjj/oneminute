"use client";

import { useState } from "react";
import { suggestMissingChunked, type MissedSuggestion } from "@/lib/chunk-analyze";

// "What did I miss?" — the human's minutes stay the source of truth; this only
// proposes gaps, and nothing enters the meeting until it's accepted here.
export default function SuggestionsPanel({
  transcript,
  captured,
  areas,
  onAccept,
  disabled
}: {
  transcript: string;
  captured: { title: string; description: string; type: string }[];
  areas: string[];
  onAccept: (s: MissedSuggestion) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [suggestions, setSuggestions] = useState<MissedSuggestion[] | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    setAccepted(new Set());
    setProgress(null);
    try {
      const out = await suggestMissingChunked(transcript, captured, areas, (p) =>
        setProgress({ done: p.done, total: p.total })
      );
      setSuggestions(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check the transcript");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="rounded-lg border-2 border-dashed border-amber-300 bg-amber-50/50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={run}
          disabled={disabled || busy || !transcript.trim()}
          className="rounded bg-amber-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          title="Compare your minutes against the transcript and list anything missing"
        >
          {busy
            ? progress && progress.total > 1
              ? `Checking… ${Math.min(progress.done + 1, progress.total)}/${progress.total}`
              : "Checking…"
            : "💡 What did I miss?"}
        </button>
        <span className="text-xs text-slate-500">
          Reads your minutes and the transcript, then suggests only what you haven&apos;t already
          written. Nothing is added unless you accept it.
        </span>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {suggestions !== null && !busy && (
        <div className="mt-3">
          {suggestions.length === 0 ? (
            <p className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700">
              ✓ Nothing obvious missing — your minutes cover what was discussed.
            </p>
          ) : (
            <>
              <div className="mb-2 text-sm font-medium text-slate-700">
                {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}
              </div>
              <ul className="space-y-2">
                {suggestions.map((s, i) => {
                  const isAccepted = accepted.has(i);
                  return (
                    <li
                      key={i}
                      className={`rounded border p-2 text-sm ${
                        isAccepted ? "border-emerald-300 bg-emerald-50" : "border-amber-200 bg-white"
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="flex items-baseline gap-2">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                            {s.minuteType}
                          </span>
                          <span className="font-medium">{s.title}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                            {s.area}
                          </span>
                          {isAccepted ? (
                            <span className="text-xs font-medium text-emerald-700">Added ✓</span>
                          ) : (
                            <button
                              onClick={() => {
                                onAccept(s);
                                setAccepted((prev) => new Set(prev).add(i));
                              }}
                              className="rounded bg-brand-blue px-2 py-1 text-xs font-medium text-white"
                            >
                              + Add to minutes
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
