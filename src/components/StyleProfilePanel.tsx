"use client";

import { useEffect, useState } from "react";

interface StyleState {
  profile: string | null;
  meetingsSeen: number;
  editedByHand: boolean;
  meetingCount: number;
}

// What "good minutes" look like on this project, learned from the ones already
// written and applied to AI Recommendation.
//
// It is shown as editable prose on purpose: the value of learning a style is
// only real if the person can read what was learned and correct it. Nothing runs
// on a schedule — learning is an explicit action, so a hand-edited profile is
// never silently overwritten.
export default function StyleProfilePanel({ projectId }: { projectId: string }) {
  const [state, setState] = useState<StyleState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/style`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j) setState(j);
      })
      .catch(() => { /* leave unset — the panel just offers to learn */ });
    return () => { cancelled = true; };
  }, [projectId]);

  async function learn() {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const res = await fetch(`/api/projects/${projectId}/style`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Could not learn the style");
      setState((s) => ({
        profile: j.profile,
        meetingsSeen: j.meetingsSeen,
        editedByHand: false,
        meetingCount: s?.meetingCount ?? 0
      }));
      setMsg(`Learned from ${j.meetingsSeen} meeting${j.meetingsSeen === 1 ? "" : "s"}.`);
      setOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not learn the style");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/style`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: draft })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Could not save");
      setState((s) => (s ? { ...s, profile: j.profile, editedByHand: true } : s));
      setEditing(false);
      setMsg("Saved — suggestions will follow this.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const has = !!state?.profile;
  // Learned a while ago: the project has moved on since.
  const stale =
    has && state!.meetingCount > state!.meetingsSeen + 5
      ? `learned from ${state!.meetingsSeen}, there are now ${state!.meetingCount}`
      : null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-sm font-semibold text-slate-700">
          Minute-taking style
          <span className="ml-2 text-xs font-normal text-slate-400">
            {has
              ? `AI follows this${state!.editedByHand ? " · edited by you" : ""}`
              : "not learned yet"}
          </span>
        </span>
        <span className="text-slate-400">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-xs text-slate-500">
            What good minutes look like on this project, learned from the ones already written.
            AI Recommendation follows it, so suggestions arrive in your words and at your level
            of detail. Edit it freely — your wording wins.
          </p>

          {has && !editing && (
            <div className="whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-3 text-slate-700">
              {state!.profile}
            </div>
          )}

          {editing && (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={8}
              className="w-full resize-y rounded border border-brand-blue p-2 text-slate-700"
              placeholder="Describe how minutes should be written on this project…"
            />
          )}

          {stale && !editing && (
            <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              This was {stale} meetings on the project — worth learning again if the way you
              record things has moved on.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!editing ? (
              <>
                <button
                  onClick={learn}
                  disabled={busy}
                  className="rounded bg-brand-blue px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  title="Read this project's minutes and describe how they are written"
                >
                  {busy ? "Learning…" : has ? "Learn again" : "Learn my style"}
                </button>
                {has && (
                  <button
                    onClick={() => {
                      setDraft(state!.profile ?? "");
                      setEditing(true);
                      setMsg("");
                    }}
                    className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700"
                  >
                    Edit
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  onClick={save}
                  disabled={busy}
                  className="rounded bg-brand-blue px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700"
                >
                  Cancel
                </button>
              </>
            )}
            {msg && <span className="text-xs font-medium text-emerald-700">{msg}</span>}
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>

          {!has && !editing && (
            <p className="text-xs text-slate-400">
              Needs a few committed meetings to learn from. Until then, suggestions use the
              minutes written in the meeting being checked.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
