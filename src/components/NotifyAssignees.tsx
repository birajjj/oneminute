"use client";

import { useEffect, useState } from "react";

interface Recipient {
  name: string;
  email: string;
  items: number;
}

interface Unreachable {
  name: string;
  reason: string;
}

// Offered after a meeting is saved: tell the people who now own work that they
// own it. Assignees are roster people, not login accounts — without this they
// never find out.
//
// Deliberately a click, not automatic. It names exactly who will be emailed
// before sending, and re-saving a meeting should never fire a second round of
// mail at everyone.
export default function NotifyAssignees({ meetingId }: { meetingId: string }) {
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [unreachable, setUnreachable] = useState<Unreachable[]>([]);
  const [configured, setConfigured] = useState(true);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/meetings/${meetingId}/notify-assignees`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        setRecipients(j.recipients ?? []);
        setUnreachable(j.unreachable ?? []);
        setConfigured(!!j.configured);
      })
      .catch(() => { /* stay silent — this is an extra, not the main flow */ });
    return () => { cancelled = true; };
  }, [meetingId]);

  async function send() {
    setSending(true);
    setError("");
    try {
      const res = await fetch(`/api/meetings/${meetingId}/notify-assignees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Could not send");
      setSentTo(j.recipients ?? []);
      if (j.failed?.length) {
        setError(`Could not reach: ${j.failed.join(", ")}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send");
    } finally {
      setSending(false);
    }
  }

  // Nothing assigned, or nobody reachable — say nothing rather than show an
  // empty control.
  if (!recipients || (recipients.length === 0 && unreachable.length === 0)) return null;

  const cannotReach =
    unreachable.length > 0 ? (
      <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
        No email on file for {unreachable.map((u) => u.name).join(", ")} — add an address to
        their team member record to include them.
      </p>
    ) : null;

  // Everyone with items is unreachable: say so instead of showing a dead button.
  if (recipients.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-sm font-semibold text-slate-700">
          Let people know what they picked up
        </div>
        {cannotReach}
      </div>
    );
  }

  const total = recipients.reduce((n, r) => n + r.items, 0);

  if (sentTo) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        <div className="font-semibold">
          Told {sentTo.length} {sentTo.length === 1 ? "person" : "people"} about their items.
        </div>
        {error && <div className="mt-1 text-red-700">{error}</div>}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-sm font-semibold text-slate-700">
        Let people know what they picked up
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {total} item{total === 1 ? " was" : "s were"} assigned in this meeting. Each person gets
        their own email listing only their items — they don&apos;t see anyone else&apos;s.
      </p>

      <ul className="mt-2 flex flex-wrap gap-2">
        {recipients.map((r) => (
          <li
            key={r.email}
            className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
            title={r.email}
          >
            {r.name} <span className="text-slate-400">· {r.items}</span>
          </li>
        ))}
      </ul>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Optional note to open the email with…"
        className="mt-3 w-full resize-y rounded border border-slate-300 p-1.5 text-sm"
      />

      {cannotReach}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={send}
          disabled={sending || !configured}
          className="rounded bg-brand-blue px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          title={configured ? undefined : "Email is not configured"}
        >
          {sending
            ? "Sending…"
            : `Notify ${recipients.length} ${recipients.length === 1 ? "person" : "people"}`}
        </button>
        {!configured && (
          <span className="text-xs text-amber-700">
            Email isn&apos;t configured yet — set it up to use this.
          </span>
        )}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
