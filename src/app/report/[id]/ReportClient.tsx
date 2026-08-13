"use client";

import { useEffect, useRef, useState } from "react";

export interface ReportMinute {
  id: string;
  area: string;
  title: string;
  description: string | null;
  type: string; // label
  status: string; // label
  assignedTo: string | null;
  dueDate: string | null; // ISO
  tags: string[];
  devopsItemId: number | null;
}

export interface ReportUpdate {
  id: string;
  area: string;
  title: string;
  note: string | null;
  type: string;
  status: string; // new status (label)
  priorStatus: string; // status before this meeting (label)
  assignedTo: string | null;
  dueDate: string | null;
}

export interface ReportData {
  meetingId: string;
  title: string;
  date: string; // ISO
  projectName: string;
  attendee: string | null;
  newMinutes: ReportMinute[];
  updates: ReportUpdate[];
  attachments: { id: string; fileName: string; size: number }[];
}

const ACTION_TYPES = ["To-Do", "Action", "Devops"];

function fmtLong(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}
function fmtShort(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

export default function ReportClient({ data }: { data: ReportData }) {
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  async function generateSummary() {
    setGenerating(true);
    try {
      const res = await fetch(`/api/meetings/${data.meetingId}/report-summary`, {
        method: "POST"
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && summaryRef.current) summaryRef.current.innerText = j.summary || "";
    } catch {
      /* leave the field editable */
    } finally {
      setGenerating(false);
    }
  }
  // Draft a summary automatically when the report opens (editable afterwards).
  useEffect(() => {
    generateSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function copyReport() {
    const node = reportRef.current;
    const sel = window.getSelection();
    if (!node || !sel) return;
    const range = document.createRange();
    range.selectNode(node);
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      document.execCommand("copy");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
    sel.removeAllRanges();
  }

  const visible = data.newMinutes.filter((m) => includeCancelled || m.status !== "Cancelled");
  const updates = data.updates.filter((u) => includeCancelled || u.status !== "Cancelled");
  const actions = visible.filter((m) => ACTION_TYPES.includes(m.type));
  const decisions = visible.filter((m) => m.type === "Note" && m.tags.includes("Decision"));
  const notesByArea: Record<string, ReportMinute[]> = {};
  for (const m of visible) {
    if (ACTION_TYPES.includes(m.type)) continue;
    if (m.type === "Note" && m.tags.includes("Decision")) continue;
    (notesByArea[m.area] ??= []).push(m);
  }
  const areas = Object.keys(notesByArea).sort();
  const hasNew = visible.length > 0;

  return (
    <div className="min-h-screen bg-slate-100">
      <style>{`
        [contenteditable]:empty:before { content: attr(data-ph); color: #94a3b8; }
        [contenteditable] { outline: none; }
        .report-paper { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        @media print {
          .no-print { display: none !important; }
          [contenteditable]:empty:before { content: "" !important; }
          body { background: #fff; }
          .report-paper { box-shadow: none !important; border: 0 !important; max-width: none !important; padding: 0 !important; }
          .cover-note { border: 0 !important; padding: 0 !important; }
          @page { margin: 16mm; }
        }
      `}</style>

      {/* Toolbar (never printed) */}
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <a
          href="/browse"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ← Back
        </a>
        <span className="text-sm font-medium text-slate-600">Meeting report</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={includeCancelled}
              onChange={(e) => setIncludeCancelled(e.target.checked)}
            />
            Include cancelled
          </label>
          <button
            onClick={generateSummary}
            disabled={generating}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
          >
            {generating ? "Summarizing…" : "✨ Regenerate summary"}
          </button>
          <button
            onClick={copyReport}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button
            onClick={() => window.print()}
            className="rounded bg-brand-blue px-3 py-1.5 text-sm font-medium text-white"
          >
            Download / Print PDF
          </button>
        </div>
      </div>

      {/* The printable report */}
      <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">
        <div
          ref={reportRef}
          className="report-paper rounded-lg border border-slate-200 bg-white p-8 text-slate-800 shadow-sm"
        >
          {/* Header */}
          <header className="border-b border-slate-200 pb-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-brand-blue">
              {data.projectName}
            </div>
            <h1 className="mt-1 text-2xl font-bold">{data.title}</h1>
            <div className="mt-1 text-sm text-slate-500">
              {fmtLong(data.date)}
              {data.attendee ? ` · ${data.attendee}` : ""}
            </div>
          </header>

          {/* Optional cover note */}
          <div
            className="cover-note mt-4 rounded border border-dashed border-slate-200 p-2 text-sm text-slate-700"
            contentEditable
            suppressContentEditableWarning
            data-ph="Add an optional note to stakeholders…"
          />

          {/* Executive summary */}
          <section className="mt-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Summary
            </h2>
            <div
              ref={summaryRef}
              className="mt-1 text-[15px] leading-relaxed"
              contentEditable
              suppressContentEditableWarning
              data-ph={generating ? "Generating summary…" : "Write a short summary…"}
            />
          </section>

          {/* Updates to carried-forward items (only present on follow-up meetings) */}
          {updates.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-amber-700">
                Updates to ongoing items
              </h2>
              <ul className="mt-2 space-y-2">
                {updates.map((u) => (
                  <li
                    key={u.id}
                    className="rounded border-l-4 border-l-amber-400 bg-amber-50 p-2 text-sm"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{u.title}</span>
                      <span className="whitespace-nowrap text-xs font-medium text-slate-500">
                        {u.priorStatus !== u.status
                          ? `${u.priorStatus} → ${u.status}`
                          : u.status}
                      </span>
                    </div>
                    {u.note && <div className="mt-0.5 text-slate-600">{u.note}</div>}
                    {(u.assignedTo || u.dueDate) && (
                      <div className="mt-0.5 text-xs text-slate-400">
                        {u.assignedTo ?? ""}
                        {u.assignedTo && u.dueDate ? " · " : ""}
                        {u.dueDate ? `due ${fmtShort(u.dueDate)}` : ""}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Delineate new items when the report also carries updates. */}
          {updates.length > 0 && hasNew && (
            <h2 className="mt-7 text-sm font-bold uppercase tracking-wide text-slate-600">
              New this meeting
            </h2>
          )}

          {/* Decisions */}
          {decisions.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Decisions
              </h2>
              <ul className="mt-2 space-y-2">
                {decisions.map((d) => (
                  <li
                    key={d.id}
                    className="rounded border-l-4 border-l-brand-purple bg-purple-50 p-2 text-sm"
                  >
                    <div className="font-medium">{d.title}</div>
                    {d.description && <div className="text-slate-600">{d.description}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Action items */}
          {actions.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Action items
              </h2>
              <table className="mt-2 w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-300 text-left text-xs uppercase text-slate-400">
                    <th className="py-1 pr-2 font-semibold">Item</th>
                    <th className="py-1 pr-2 font-semibold">Owner</th>
                    <th className="py-1 pr-2 font-semibold">Due</th>
                    <th className="py-1 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {actions.map((a) => (
                    <tr key={a.id} className="border-b border-slate-100 align-top">
                      <td className="py-1.5 pr-2">
                        <div className="font-medium">{a.title}</div>
                        {a.description && <div className="text-slate-500">{a.description}</div>}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-2">{a.assignedTo ?? "—"}</td>
                      <td className="whitespace-nowrap py-1.5 pr-2">
                        {a.dueDate ? fmtShort(a.dueDate) : "—"}
                      </td>
                      <td className="whitespace-nowrap py-1.5">{a.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Discussion notes, grouped by area */}
          {areas.map((area) => (
            <section key={area} className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                {area}
              </h2>
              <ul className="mt-2 space-y-1.5 text-sm">
                {notesByArea[area].map((n) => (
                  <li key={n.id} className="border-l-2 border-slate-200 pl-2">
                    <span className="font-medium">{n.title}</span>
                    {n.description && <span className="text-slate-600"> — {n.description}</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {/* Attachments */}
          {data.attachments.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Attachments
              </h2>
              <ul className="mt-2 space-y-0.5 text-sm text-slate-600">
                {data.attachments.map((a) => (
                  <li key={a.id}>📎 {a.fileName}</li>
                ))}
              </ul>
            </section>
          )}

          {!hasNew && updates.length === 0 && (
            <p className="mt-6 text-sm text-slate-400">
              No minutes were captured in this meeting.
            </p>
          )}

          <footer className="mt-8 border-t border-slate-200 pt-3 text-xs text-slate-400">
            {data.projectName} · report generated {fmtLong(new Date().toISOString())}
          </footer>
        </div>
      </div>
    </div>
  );
}
