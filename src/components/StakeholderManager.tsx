"use client";

import { useEffect, useState } from "react";

export interface Stakeholder {
  id: string;
  name: string;
  email: string;
}

// Manage the project's report recipients: add (name + email), list, remove.
// Project-scoped so the same list serves every meeting in the project. The
// actual "email report" send is a separate step (awaiting the mail provider).
export default function StakeholderManager({
  projectId,
  meetingId,
  meetingTitle
}: {
  projectId: string;
  meetingId: string;
  meetingTitle: string;
}) {
  const [list, setList] = useState<Stakeholder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // --- Sending -------------------------------------------------------------
  // Recipients are ticked explicitly; nothing is ever sent to the whole list by
  // default, and the send button always names who it is about to email.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState(`${meetingTitle} — meeting report`);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState("");
  const [sendErr, setSendErr] = useState("");

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function preview() {
    setSendErr("");
    setSendMsg("");
    try {
      const res = await fetch(`/api/meetings/${meetingId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stakeholderIds: [...picked],
          subject,
          note,
          preview: true
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Could not build a preview");
      const w = window.open("", "_blank");
      if (w) {
        w.document.write(j.html);
        w.document.close();
      }
    } catch (e) {
      setSendErr(e instanceof Error ? e.message : "Could not build a preview");
    }
  }

  async function send() {
    setSending(true);
    setSendErr("");
    setSendMsg("");
    try {
      const res = await fetch(`/api/meetings/${meetingId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stakeholderIds: [...picked], subject, note })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Send failed");
      setSendMsg(`Sent to ${j.sent} recipient${j.sent === 1 ? "" : "s"}.`);
      setPicked(new Set());
    } catch (e) {
      setSendErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/stakeholders`)
      .then((r) => (r.ok ? r.json() : { stakeholders: [] }))
      .then((j) => {
        if (!cancelled) setList(j.stakeholders ?? []);
      })
      .catch(() => { /* leave empty */ })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function add() {
    const n = name.trim();
    const e = email.trim();
    if (!n || !e) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/stakeholders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n, email: e })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Could not add");
      // Replace any existing row with the same email (upsert), else append.
      setList((prev) => {
        const without = prev.filter((s) => s.id !== j.stakeholder.id && s.email !== j.stakeholder.email);
        return [...without, j.stakeholder].sort((a, b) => a.name.localeCompare(b.name));
      });
      setName("");
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setList((prev) => prev.filter((s) => s.id !== id)); // optimistic
    try {
      await fetch(`/api/stakeholders/${id}`, { method: "DELETE" });
    } catch {
      /* a refresh will re-sync if it failed */
    }
  }

  return (
    <div className="no-print rounded-lg border border-slate-200 bg-white p-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-sm font-semibold text-slate-700">
          Stakeholders
          <span className="ml-2 text-xs font-normal text-slate-400">
            {loaded ? `${list.length} on this project` : "loading…"}
          </span>
        </span>
        <span className="text-slate-400">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {list.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {list.map((s) => (
                <li key={s.id} className="flex items-center justify-between py-1.5 text-sm">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={picked.has(s.id)}
                      onChange={() => togglePick(s.id)}
                    />
                    <span className="font-medium text-slate-800">{s.name}</span>
                    <span className="text-slate-500">{s.email}</span>
                  </label>
                  <button
                    onClick={() => remove(s.id)}
                    className="rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                    title="Remove this stakeholder"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            loaded && <p className="text-sm text-slate-400">No stakeholders yet.</p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              className="w-40 rounded border border-slate-300 p-1.5 text-sm"
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@company.com"
              type="email"
              className="w-56 rounded border border-slate-300 p-1.5 text-sm"
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            />
            <button
              onClick={add}
              disabled={busy || !name.trim() || !email.trim()}
              className="rounded bg-brand-blue px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              + Add
            </button>
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>
          {/* Send this meeting's report. Recipients must be ticked; the button
              says exactly how many will receive it. */}
          {list.length > 0 && (
            <div className="space-y-2 border-t border-slate-100 pt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Email this report
              </div>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                className="w-full rounded border border-slate-300 p-1.5 text-sm"
              />
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Optional note to open the email with…"
                className="w-full resize-y rounded border border-slate-300 p-1.5 text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={preview}
                  disabled={picked.size === 0}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
                  title="Open the email exactly as it will arrive — nothing is sent"
                >
                  Preview
                </button>
                <button
                  onClick={send}
                  disabled={sending || picked.size === 0}
                  className="rounded bg-brand-blue px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                >
                  {sending
                    ? "Sending…"
                    : picked.size === 0
                      ? "Select recipients"
                      : `Send to ${picked.size} stakeholder${picked.size === 1 ? "" : "s"}`}
                </button>
                {sendMsg && <span className="text-xs font-medium text-emerald-700">{sendMsg}</span>}
                {sendErr && <span className="text-xs text-red-600">{sendErr}</span>}
              </div>
              <p className="text-xs text-slate-400">
                Each person receives their own copy — recipients never see each other.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
