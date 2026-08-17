"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectItem, ProjectMeta } from "@/lib/project-report";
import { describesNoProgress } from "@/lib/notes";

const ACTION_TYPES = ["To-Do", "Action", "Devops"];

const TYPE_BADGE: Record<string, string> = {
  Note: "bg-slate-100 text-slate-600",
  "To-Do": "bg-blue-100 text-blue-700",
  Action: "bg-emerald-100 text-emerald-700",
  Devops: "bg-orange-100 text-orange-700"
};

const HEALTH: Record<string, string> = {
  "On track": "bg-emerald-100 text-emerald-700",
  "At risk": "bg-amber-100 text-amber-700",
  "Off track": "bg-red-100 text-red-700"
};

function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
        TYPE_BADGE[type] ?? "bg-slate-100 text-slate-600"
      }`}
    >
      {type}
    </span>
  );
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function isOpen(status: string) {
  return status !== "Closed" && status !== "Cancelled";
}
function isOverdue(iso: string | null) {
  return !!iso && new Date(iso) < startOfToday();
}
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
function byDue(a: ProjectItem, b: ProjectItem) {
  const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
  const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
  if (ad !== bd) return ad - bd;
  return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
}
function byRecent(a: ProjectItem, b: ProjectItem) {
  return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
}

export default function ProjectReportClient({
  projectId,
  projectName,
  items,
  meta
}: {
  projectId: string;
  projectName: string;
  items: ProjectItem[];
  meta: ProjectMeta;
}) {
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [showNotes, setShowNotes] = useState(true);
  // Default the health from the data rather than always claiming "On track" —
  // saying that with overdue items on the page invites a challenge. Overridable.
  const [health, setHealth] = useState(() =>
    items.some((it) => isOpen(it.status) && isOverdue(it.dueDate)) ? "At risk" : "On track"
  );
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  const shown = items.filter((it) => includeCancelled || it.status !== "Cancelled");
  const actions = shown.filter((it) => ACTION_TYPES.includes(it.type));
  // "Done" covers Resolved and Closed. Resolved still carries forward internally,
  // but listing it under BOTH "Open items" and "Resolved & closed" reads as a
  // contradiction to a client, so it lives here only.
  const done = actions
    .filter((it) => it.status === "Resolved" || it.status === "Closed")
    .sort(byRecent);
  const stillOpen = actions.filter(
    (it) => isOpen(it.status) && it.status !== "Resolved"
  );
  const overdue = stillOpen.filter((it) => isOverdue(it.dueDate)).sort(byDue);
  const openOther = stillOpen.filter((it) => !isOverdue(it.dueDate));
  const decisions = shown.filter((it) => it.type === "Note" && it.tags.includes("Decision"));
  // Everything else that was captured — previously dropped from the report.
  const notes = shown.filter(
    (it) => !ACTION_TYPES.includes(it.type) && !it.tags.includes("Decision")
  );

  // Highlights = what genuinely MOVED. An item that was merely mentioned again,
  // or whose latest note says nothing happened, is not progress. Deliberately a
  // one-line recap (detail lives in the sections below), capped so it stays a
  // highlight reel rather than a second copy of the report.
  const highlights = useMemo(
    () =>
      shown
        .filter((it) => it.updateCount > 0 && !describesNoProgress(it.description))
        .sort(byRecent)
        .slice(0, 6),
    [shown]
  );

  const counts = {
    total: shown.length,
    open: stillOpen.length,
    overdue: overdue.length,
    resolved: actions.filter((it) => it.status === "Resolved").length,
    closed: actions.filter((it) => it.status === "Closed").length,
    noOwner: stillOpen.filter((it) => !it.assignedTo).length,
    noDue: stillOpen.filter((it) => !it.dueDate).length
  };

  // Who is carrying the open work.
  const byOwner = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of stillOpen) map.set(it.assignedTo ?? "Unassigned", (map.get(it.assignedTo ?? "Unassigned") ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, includeCancelled]);

  // A factual summary built from the data, so the report is never blank.
  const autoSummary = useMemo(() => {
    const period =
      meta.firstMeeting && meta.lastMeeting
        ? `Across ${meta.meetingCount} meeting${meta.meetingCount === 1 ? "" : "s"} between ${fmtShort(meta.firstMeeting)} and ${fmtShort(meta.lastMeeting)}, `
        : "";
    const bits = [
      `${counts.total} item${counts.total === 1 ? "" : "s"} have been captured for ${projectName}`,
      `${counts.open} action${counts.open === 1 ? "" : "s"} remain open${counts.overdue > 0 ? ` (${counts.overdue} overdue)` : ""}`,
      `${counts.resolved + counts.closed} resolved or closed`
    ];
    const tail = decisions.length
      ? ` ${decisions.length} key decision${decisions.length === 1 ? " was" : "s were"} recorded.`
      : "";
    return `${period}${period ? bits.join(", ").replace(/^./, (c) => c.toLowerCase()) : bits.join(", ")}.${tail}`;
  }, [meta, counts, decisions.length, projectName]);

  useEffect(() => {
    if (summaryRef.current && !summaryRef.current.innerText.trim()) {
      summaryRef.current.innerText = autoSummary;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generateSummary() {
    setGenerating(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/report-summary`, { method: "POST" });
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

  const openByArea: Record<string, ProjectItem[]> = {};
  for (const it of openOther) (openByArea[it.area] ??= []).push(it);
  const areas = Object.keys(openByArea).sort();
  areas.forEach((a) => openByArea[a].sort(byDue));

  const notesByArea: Record<string, ProjectItem[]> = {};
  for (const it of notes) (notesByArea[it.area] ??= []).push(it);
  const noteAreas = Object.keys(notesByArea).sort();

  // A column no row can fill is worse than no column — an Owner/Due column of
  // dashes just makes the report look unfinished, so hide them when empty.
  function ItemTable({ rows }: { rows: ProjectItem[] }) {
    const showOwner = rows.some((r) => r.assignedTo);
    const showDue = rows.some((r) => r.dueDate);
    return (
      <table className="mt-2 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-left text-xs uppercase text-slate-400">
            <th className="py-1 pr-2 font-semibold">Item</th>
            <th className="py-1 pr-2 font-semibold">Type</th>
            {showOwner && <th className="py-1 pr-2 font-semibold">Owner</th>}
            {showDue && <th className="py-1 pr-2 font-semibold">Due</th>}
            <th className="py-1 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const od = isOverdue(a.dueDate) && isOpen(a.status);
            return (
              <tr key={a.id} className="border-b border-slate-100 align-top">
                <td className="py-1.5 pr-2">
                  <div className="font-medium">{a.title}</div>
                  {a.description && <div className="text-slate-500">{a.description}</div>}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-2">
                  <TypeBadge type={a.type} />
                </td>
                {showOwner && (
                  <td className="whitespace-nowrap py-1.5 pr-2">{a.assignedTo ?? "—"}</td>
                )}
                {showDue && (
                  <td
                    className={`whitespace-nowrap py-1.5 pr-2 ${
                      od ? "font-semibold text-red-600" : ""
                    }`}
                  >
                    {a.dueDate ? fmtShort(a.dueDate) : "—"}
                  </td>
                )}
                <td className="whitespace-nowrap py-1.5">{a.status}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

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
          href={`/project/${projectId}`}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ← Back
        </a>
        <span className="text-sm font-medium text-slate-600">Project status report</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-500">
            Health
            <select
              value={health}
              onChange={(e) => setHealth(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-700"
            >
              {Object.keys(HEALTH).map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={showNotes}
              onChange={(e) => setShowNotes(e.target.checked)}
            />
            Discussion notes
          </label>
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
        <div
          ref={reportRef}
          className="report-paper rounded-lg border border-slate-200 bg-white p-8 text-slate-800 shadow-sm"
        >
          {/* Header */}
          <header className="border-b border-slate-200 pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-brand-blue">
                Project status report
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${HEALTH[health]}`}
              >
                {health}
              </span>
            </div>
            <h1 className="mt-1 text-2xl font-bold">{projectName}</h1>
            <div className="mt-1 text-sm text-slate-500">
              As at {fmtLong(new Date().toISOString())}
              {meta.meetingCount > 0 && meta.firstMeeting && meta.lastMeeting && (
                <>
                  {" · "}
                  {meta.meetingCount} meeting{meta.meetingCount === 1 ? "" : "s"} from{" "}
                  {fmtShort(meta.firstMeeting)} to {fmtShort(meta.lastMeeting)}
                </>
              )}
            </div>
          </header>

          {/* Summary — pre-filled from the data, editable, AI rewrite optional */}
          <section className="mt-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Summary
            </h2>
            <div
              ref={summaryRef}
              className="mt-1 text-[15px] leading-relaxed"
              contentEditable
              suppressContentEditableWarning
              data-ph={generating ? "Generating summary…" : "Write a short status summary…"}
            />
          </section>

          {/* Progress at a glance */}
          <section className="mt-5">
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
                {counts.open} open
              </span>
              {counts.overdue > 0 && (
                <span className="rounded-full bg-red-50 px-3 py-1 font-medium text-red-600">
                  {counts.overdue} overdue
                </span>
              )}
              {counts.resolved > 0 && (
                <span className="rounded-full bg-teal-50 px-3 py-1 font-medium text-teal-700">
                  {counts.resolved} resolved
                </span>
              )}
              <span className="rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-700">
                {counts.closed} closed
              </span>
              {decisions.length > 0 && (
                <span className="rounded-full bg-purple-50 px-3 py-1 font-medium text-brand-purple">
                  {decisions.length} decision{decisions.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {/* Who's carrying the open work */}
            {byOwner.length > 0 && (
              <div className="mt-2 text-xs text-slate-500">
                Open work by owner:{" "}
                {byOwner.map(([name, n], i) => (
                  <span key={name}>
                    {i > 0 && " · "}
                    <span className="font-medium text-slate-600">{name}</span> {n}
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* Highlights — a one-line recap of what genuinely moved. Detail for
              each item lives once, in the sections below. */}
          {highlights.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">
                Highlights
                <span className="ml-2 text-xs font-normal normal-case text-slate-400">
                  what moved — detail below
                </span>
              </h2>
              <ul className="mt-2 space-y-1 text-sm">
                {highlights.map((it) => (
                  <li key={it.id} className="flex flex-wrap items-baseline gap-x-2 border-l-2 border-brand-blue pl-2">
                    <span className="font-medium">{it.title}</span>
                    <span className="text-xs text-slate-400">
                      {it.priorStatus && it.priorStatus !== it.status
                        ? `${it.priorStatus} → ${it.status}`
                        : it.status}{" "}
                      · {fmtShort(it.lastActivity)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Overdue */}
          {overdue.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-red-600">
                Overdue &amp; at risk
              </h2>
              <ItemTable rows={overdue} />
            </section>
          )}

          {/* Decisions — outcomes stakeholders care about, so kept high rather
              than buried after a long list of open items. */}
          {decisions.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">
                Key decisions
              </h2>
              <ul className="mt-2 space-y-2">
                {decisions.map((d) => (
                  <li
                    key={d.id}
                    className="rounded border-l-4 border-l-brand-purple bg-purple-50 p-2 text-sm"
                  >
                    <div className="font-medium">{d.title}</div>
                    {d.description && <div className="mt-0.5 text-slate-600">{d.description}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Open items by area — overdue ones are above, so nothing repeats. */}
          {areas.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">
                Open items
              </h2>
              {areas.map((area) => (
                <div key={area} className="mt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {area}
                  </h3>
                  <ItemTable rows={openByArea[area]} />
                </div>
              ))}
            </section>
          )}

          {/* Resolved & closed */}
          {done.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-emerald-700">
                Resolved &amp; closed
              </h2>
              <ItemTable rows={done} />
            </section>
          )}

          {/* Discussion notes — everything else that was captured */}
          {showNotes && noteAreas.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">
                Discussion &amp; context
              </h2>
              {noteAreas.map((area) => (
                <div key={area} className="mt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {area}
                  </h3>
                  <ul className="mt-1 space-y-1 text-sm">
                    {notesByArea[area].map((n) => (
                      <li key={n.id} className="border-l-2 border-slate-200 pl-2">
                        <span className="font-medium">{n.title}</span>
                        {n.description && (
                          <span className="text-slate-600"> — {n.description}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          {/* Data gaps — helps the owner tidy up before sending */}
          {(counts.noOwner > 0 || counts.noDue > 0) && (
            <section className="no-print mt-6 rounded border border-dashed border-slate-300 bg-slate-50 p-2 text-xs text-slate-500">
              Before sending: {counts.noOwner > 0 && <>{counts.noOwner} open item{counts.noOwner === 1 ? "" : "s"} have no owner</>}
              {counts.noOwner > 0 && counts.noDue > 0 && " · "}
              {counts.noDue > 0 && <>{counts.noDue} have no due date</>}. Set them on the
              project board so this report reads complete.
            </section>
          )}

          {shown.length === 0 && (
            <p className="mt-6 text-sm text-slate-400">
              No items have been captured for this project yet.
            </p>
          )}

          <footer className="mt-8 border-t border-slate-200 pt-3 text-xs text-slate-400">
            {projectName} · report generated {fmtLong(new Date().toISOString())}
          </footer>
        </div>
      </div>
    </div>
  );
}
