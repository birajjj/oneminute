"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import StakeholderManager from "@/components/StakeholderManager";

export interface ReportItem {
  id: string;
  rootId: string;
  area: string;
  title: string;
  type: string; // the ITEM's type (To-Do / Action / Devops / Note)
  status: string; // current status, label
  priorStatus: string | null; // status before this meeting (updates only)
  isUpdate: boolean; // true = update to a carried-forward item
  note: string | null; // what was said this meeting
  assignedTo: string | null;
  dueDate: string | null; // ISO
  tags: string[];
  devopsItemId: number | null;
  children: ReportItem[]; // tasks raised under this item
}

export interface ReportData {
  meetingId: string;
  title: string;
  date: string; // ISO
  projectId: string;
  projectName: string;
  attendee: string | null;
  description: string | null; // the meeting's own overview (default summary)
  items: ReportItem[];
  attachments: { id: string; fileName: string; size: number }[];
}

// Task-shaped minutes: the work the meeting committed to.
const ACTION_TYPES = ["To-Do", "Action", "Devops"];

const TYPE_BADGE: Record<string, string> = {
  Note: "bg-slate-100 text-slate-600",
  "To-Do": "bg-blue-100 text-blue-700",
  Action: "bg-emerald-100 text-emerald-700",
  Devops: "bg-orange-100 text-orange-700"
};

// Status drives the colour, so the eye lands on what moved.
const STATUS_PILL: Record<string, string> = {
  New: "bg-slate-100 text-slate-600",
  Initiated: "bg-indigo-100 text-indigo-700",
  "In Progress": "bg-blue-100 text-blue-700",
  Resolved: "bg-teal-100 text-teal-700",
  Closed: "bg-emerald-100 text-emerald-700",
  Cancelled: "bg-slate-200 text-slate-500"
};
const FLAG_BADGE: Record<string, string> = {
  Decision: "bg-purple-100 text-brand-purple",
  Scope: "bg-amber-100 text-amber-700",
  Governance: "bg-sky-100 text-sky-700"
};

const STATUS_EDGE: Record<string, string> = {
  New: "border-l-slate-300",
  Initiated: "border-l-indigo-400",
  "In Progress": "border-l-blue-500",
  Resolved: "border-l-teal-500",
  Closed: "border-l-emerald-500",
  Cancelled: "border-l-slate-300"
};

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
function flatten(items: ReportItem[]): ReportItem[] {
  return items.flatMap((i) => [i, ...flatten(i.children)]);
}

export default function ReportClient({ data }: { data: ReportData }) {
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  // Ordered by what a reader needs, not by workstream: the work people committed
  // to, then the outcomes worth recording, then the background. Each item is
  // claimed ONCE — a flagged Action stays with the actions and simply shows its
  // flag, rather than being repeated under Decisions. Area moves onto the item as
  // a chip, so it is still visible without three sets of repeated headings.
  const { actionItems, decisions, notes, all } = useMemo(() => {
    const keep = (it: ReportItem): ReportItem | null => {
      if (!includeCancelled && it.status === "Cancelled") return null;
      const kids = it.children.map(keep).filter(Boolean) as ReportItem[];
      return { ...it, children: kids };
    };
    const kept = data.items.map(keep).filter(Boolean) as ReportItem[];
    const isTask = (it: ReportItem) => ACTION_TYPES.includes(it.type);
    const isFlagged = (it: ReportItem) =>
      it.tags.some((t) => ["Decision", "Scope", "Governance"].includes(t));
    // Classified on the TOP-LEVEL item so a task nested under its parent keeps
    // travelling with it.
    const actionItems = kept.filter(isTask);
    const rest = kept.filter((it) => !isTask(it));
    return {
      actionItems,
      decisions: rest.filter(isFlagged),
      notes: rest.filter((it) => !isFlagged(it)),
      all: flatten(kept)
    };
  }, [data.items, includeCancelled]);

  const counts = useMemo(() => {
    const discussed = all.filter((i) => i.isUpdate).length;
    return {
      discussed,
      raised: all.filter((i) => !i.isUpdate).length,
      closed: all.filter((i) => i.status === "Closed").length,
      resolved: all.filter((i) => i.status === "Resolved").length,
      inProgress: all.filter((i) => i.status === "In Progress").length
    };
  }, [all]);

  // Never open on a blank summary: use the meeting's own overview, else state
  // the facts. Editable either way; "Rewrite with AI" replaces it.
  const autoSummary = useMemo(() => {
    const bits: string[] = [];
    if (counts.discussed) bits.push(`${counts.discussed} ongoing item${counts.discussed === 1 ? "" : "s"} reviewed`);
    if (counts.raised) bits.push(`${counts.raised} new item${counts.raised === 1 ? "" : "s"} raised`);
    if (counts.closed) bits.push(`${counts.closed} closed`);
    if (counts.resolved) bits.push(`${counts.resolved} resolved`);
    return bits.length ? `${bits.join(", ")}.` : "";
  }, [counts]);

  useEffect(() => {
    if (summaryRef.current && !summaryRef.current.innerText.trim()) {
      summaryRef.current.innerText = data.description?.trim() || autoSummary;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generateSummary() {
    setGenerating(true);
    try {
      const res = await fetch(`/api/meetings/${data.meetingId}/report-summary`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.summary && summaryRef.current) summaryRef.current.innerText = j.summary;
    } catch {
      /* leave editable */
    } finally {
      setGenerating(false);
    }
  }

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

  function Item({ it, nested }: { it: ReportItem; nested: boolean }) {
    const moved = it.isUpdate && it.priorStatus && it.priorStatus !== it.status;
    return (
      <li className={nested ? "" : "mt-2 first:mt-0"}>
        <div
          className={`rounded border border-slate-200 border-l-4 bg-white p-2.5 ${
            STATUS_EDGE[it.status] ?? "border-l-slate-300"
          }`}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  TYPE_BADGE[it.type] ?? "bg-slate-100 text-slate-600"
                }`}
              >
                {it.type}
              </span>
              <span className="font-medium text-slate-800">{it.title}</span>
              {!it.isUpdate && (
                <span className="shrink-0 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-blue">
                  new
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs">
              {moved && <span className="text-slate-400">{it.priorStatus} →</span>}
              <span
                className={`rounded-full px-2 py-0.5 font-semibold ${
                  STATUS_PILL[it.status] ?? "bg-slate-100 text-slate-600"
                }`}
              >
                {it.status}
              </span>
            </span>
          </div>

          {it.note && <p className="mt-1 text-sm text-slate-600">{it.note}</p>}

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
            {it.assignedTo && <span>👤 {it.assignedTo}</span>}
            {it.dueDate && <span>📅 due {fmtShort(it.dueDate)}</span>}
            {it.devopsItemId && <span>DevOps #{it.devopsItemId}</span>}
            {it.tags.map((t) => (
              <span
                key={t}
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  FLAG_BADGE[t] ?? "bg-slate-100 text-slate-500"
                }`}
              >
                {t}
              </span>
            ))}
            {!nested && <span className="text-slate-500">{it.area}</span>}
          </div>

          {/* Tasks raised under this item — keeps a workstream in one block. */}
          {it.children.length > 0 && (
            <ul className="mt-2 space-y-2 border-l-2 border-slate-200 pl-3">
              {it.children.map((c) => (
                <Item key={c.id} it={c} nested />
              ))}
            </ul>
          )}
        </div>
      </li>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <style>{`
        [contenteditable]:empty:before { content: attr(data-ph); color: #cbd5e1; }
        [contenteditable] { outline: none; }
        .report-paper { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        @media print {
          .no-print { display: none !important; }
          [contenteditable]:empty:before { content: "" !important; }
          body { background: #fff; }
          .report-paper { box-shadow: none !important; border: 0 !important; max-width: none !important; padding: 0 !important; }
          .cover-note { border: 0 !important; padding: 0 !important; }
          /* Keep an ITEM whole, but let a section flow across pages — a
             section that must not break gets pushed wholesale to the next page,
             which is what left large blank areas at the foot of a page. */
          section { break-inside: auto; }
          li, tr { break-inside: avoid; }
          h1, h2, h3 { break-after: avoid; }
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
            {generating ? "Summarizing…" : "✨ Rewrite with AI"}
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
        <div className="mb-4">
          <StakeholderManager projectId={data.projectId} meetingId={data.meetingId} meetingTitle={data.title} />
        </div>
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

          {/* Summary */}
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

          {/* Progress at a glance */}
          {all.length > 0 && (
            <section className="mt-4 flex flex-wrap gap-2 text-sm">
              {counts.discussed > 0 && (
                <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
                  {counts.discussed} reviewed
                </span>
              )}
              {counts.inProgress > 0 && (
                <span className="rounded-full bg-blue-50 px-3 py-1 font-medium text-blue-700">
                  {counts.inProgress} in progress
                </span>
              )}
              {counts.resolved > 0 && (
                <span className="rounded-full bg-teal-50 px-3 py-1 font-medium text-teal-700">
                  {counts.resolved} resolved
                </span>
              )}
              {counts.closed > 0 && (
                <span className="rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-700">
                  {counts.closed} closed
                </span>
              )}
              {counts.raised > 0 && (
                <span className="rounded-full bg-purple-50 px-3 py-1 font-medium text-brand-purple">
                  {counts.raised} newly raised
                </span>
              )}
            </section>
          )}

          {/* 1. The work people committed to — what a reader needs first. */}
          {actionItems.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">
                Actions, to-dos &amp; devops
                <span className="ml-2 text-xs font-normal normal-case text-slate-400">
                  {actionItems.length}
                </span>
              </h2>
              <ul className="mt-2">
                {actionItems.map((it) => (
                  <Item key={it.id} it={it} nested={false} />
                ))}
              </ul>
            </section>
          )}

          {/* 2. Outcomes worth recording — anything carrying a governance flag. */}
          {decisions.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-brand-purple">
                Decisions, scope &amp; governance
                <span className="ml-2 text-xs font-normal normal-case text-slate-400">
                  {decisions.length}
                </span>
              </h2>
              <ul className="mt-2">
                {decisions.map((it) => (
                  <Item key={it.id} it={it} nested={false} />
                ))}
              </ul>
            </section>
          )}

          {/* 3. Background — read only if you want the detail. */}
          {notes.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
                Notes &amp; discussion
                <span className="ml-2 text-xs font-normal normal-case text-slate-400">
                  {notes.length}
                </span>
              </h2>
              <ul className="mt-2">
                {notes.map((it) => (
                  <Item key={it.id} it={it} nested={false} />
                ))}
              </ul>
            </section>
          )}

          {/* Attachments */}
          {data.attachments.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">
                Attachments
              </h2>
              <ul className="mt-2 space-y-0.5 text-sm text-slate-600">
                {data.attachments.map((a) => (
                  <li key={a.id}>📎 {a.fileName}</li>
                ))}
              </ul>
            </section>
          )}

          {all.length === 0 && (
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
