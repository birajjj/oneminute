"use client";

import { useMemo, useState } from "react";
import type { FollowUpData, OpenItem } from "@/lib/followup";

const TYPE_OPTIONS = ["Note", "To-Do", "Action", "Devops"];
const STATUS_OPTIONS = ["New", "Initiated", "In Progress", "Completed", "Cancelled"];

interface Member {
  id: string;
  displayName: string;
}

interface ItemUpdate {
  noUpdate: boolean;
  status: string;
  note: string;
  assignedTo: string;
  dueDate: string;
}

interface NewMinute {
  area: string;
  title: string;
  description: string;
  type: string;
  status: string;
  assignedTo: string;
  dueDate: string;
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric" }) +
    ", " +
    d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })
  );
}

export default function FollowUpClient({
  data,
  members,
  devopsBaseUrl
}: {
  data: FollowUpData;
  members: Member[];
  devopsBaseUrl: string;
}) {
  const [title, setTitle] = useState(`${data.parent.title} — Follow-up`);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const [updates, setUpdates] = useState<Record<string, ItemUpdate>>(() => {
    const init: Record<string, ItemUpdate> = {};
    for (const it of data.openItems) {
      init[it.id] = {
        noUpdate: false,
        status: it.status,
        note: "",
        assignedTo: it.assignedTo ?? "",
        dueDate: it.dueDate ? it.dueDate.slice(0, 10) : ""
      };
    }
    return init;
  });

  const [newMinutes, setNewMinutes] = useState<NewMinute[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ updated: number; created: number; warnings: string[] } | null>(null);

  const byArea = useMemo(() => {
    const map: Record<string, OpenItem[]> = {};
    for (const it of data.openItems) (map[it.area] ??= []).push(it);
    return map;
  }, [data.openItems]);

  function setUpdate(id: string, patch: Partial<ItemUpdate>) {
    setUpdates((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }
  function addNewMinute(area: string) {
    setNewMinutes((prev) => [
      ...prev,
      { area, title: "", description: "", type: "Note", status: "New", assignedTo: "", dueDate: "" }
    ]);
  }
  function setNewMinute(i: number, patch: Partial<NewMinute>) {
    setNewMinutes((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }
  function removeNewMinute(i: number) {
    setNewMinutes((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/followup/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentMeetingId: data.parent.id,
          meetingTitle: title,
          meetingDate: date,
          updates: data.openItems.map((it) => ({ rootMinuteId: it.id, ...updates[it.id] })),
          newMinutes: newMinutes.filter((m) => m.title.trim())
        })
      });
      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  // Members assignable, keeping any AI/legacy name already on an item selectable.
  function assigneeOptions(current: string) {
    const names = members.map((m) => m.displayName);
    const extra = current && !names.includes(current) ? [current] : [];
    return [...extra, ...names];
  }

  if (result) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-lg font-bold text-white">✓</div>
        <div className="flex-1">
          <div className="font-semibold">
            Follow-up saved — {result.updated} update(s), {result.created} new minute(s)
          </div>
          {result.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-amber-700">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
        <a href="/browse" className="rounded bg-brand-blue px-4 py-2 font-medium text-white">
          View in Browse
        </a>
      </div>
    );
  }

  const totalOpen = data.openItems.length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <span className="mb-2 inline-block rounded bg-gradient-to-r from-amber-500 to-brand-purple px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-white">
          Follow-up
        </span>
        <h1 className="text-2xl font-bold">Follow-up Meeting</h1>
        <p className="text-sm text-slate-600">
          Following up on <span className="font-medium">{data.parent.title}</span> · {data.parent.projectName} ·{" "}
          {fmtDate(data.parent.date)}
        </p>
      </div>

      {/* Meeting title + date */}
      <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-xs font-semibold uppercase text-slate-500">Meeting title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="text-xs font-semibold uppercase text-slate-500">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
          />
        </label>
      </div>

      {/* Carried-forward open items */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-lg font-semibold">
          Open items to review ({totalOpen})
        </h2>
        <p className="mb-3 text-xs text-slate-500">
          Go through each item and record what happened. Set status to <em>Completed</em> to close it.
          Leave one as “No update” to carry it forward unchanged.
        </p>

        {totalOpen === 0 ? (
          <p className="rounded border border-dashed border-slate-300 p-4 text-sm text-slate-500">
            No open items to carry forward from this project. You can still add new minutes below.
          </p>
        ) : (
          data.areas.map((area) => (
            <div key={area} className="mb-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">{area}</div>
              <div className="space-y-3">
                {(byArea[area] ?? []).map((it) => {
                  const u = updates[it.id];
                  return (
                    <div key={it.id} className="rounded-lg border-l-4 border-l-amber-500 bg-amber-50 p-3">
                      {/* Original item summary */}
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{it.title}</span>
                        <span className="text-xs italic text-slate-500">{it.type}</span>
                        <span className="rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-500">{it.status}</span>
                        {it.assignedTo && (
                          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600">👤 {it.assignedTo}</span>
                        )}
                        {it.devopsItemId &&
                          (devopsBaseUrl ? (
                            <a
                              href={`${devopsBaseUrl}/_workitems/edit/${it.devopsItemId}`}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 hover:bg-orange-200"
                            >
                              🔗 DevOps #{it.devopsItemId}
                            </a>
                          ) : (
                            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">
                              🔗 DevOps #{it.devopsItemId}
                            </span>
                          ))}
                      </div>
                      {it.description && <div className="mt-1 text-sm text-slate-600">{it.description}</div>}

                      {/* Prior updates */}
                      {it.history.length > 0 && (
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer text-slate-500">
                            {it.history.length} prior update(s)
                          </summary>
                          <ul className="mt-1 space-y-1 border-l-2 border-slate-200 pl-3">
                            {it.history.map((h, i) => (
                              <li key={i} className="text-slate-600">
                                <span className="text-slate-400">{fmtDate(h.date)} · {h.meetingTitle} · {h.status}</span>
                                {h.description ? <> — {h.description}</> : null}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}

                      {/* Update controls */}
                      <div className="mt-2 rounded border border-amber-200 bg-white p-2">
                        <label className="flex items-center gap-1 text-xs text-slate-600">
                          <input
                            type="checkbox"
                            checked={u.noUpdate}
                            onChange={(e) => setUpdate(it.id, { noUpdate: e.target.checked })}
                          />
                          No update this meeting (carry forward unchanged)
                        </label>

                        {!u.noUpdate && (
                          <>
                            <textarea
                              value={u.note}
                              onChange={(e) => setUpdate(it.id, { note: e.target.value })}
                              rows={2}
                              placeholder="What happened with this item?"
                              className="mt-2 w-full rounded border border-slate-300 p-2 text-sm"
                            />
                            <div className="mt-1 grid grid-cols-3 gap-1 text-xs">
                              <select
                                value={u.status}
                                onChange={(e) => setUpdate(it.id, { status: e.target.value })}
                                className="rounded border border-slate-300 p-1"
                              >
                                {STATUS_OPTIONS.map((s) => (
                                  <option key={s} value={s}>{s}</option>
                                ))}
                              </select>
                              <select
                                value={u.assignedTo}
                                onChange={(e) => setUpdate(it.id, { assignedTo: e.target.value })}
                                className="rounded border border-slate-300 p-1"
                              >
                                <option value="">— Unassigned —</option>
                                {assigneeOptions(u.assignedTo).map((n) => (
                                  <option key={n} value={n}>{n}</option>
                                ))}
                              </select>
                              <input
                                type="date"
                                value={u.dueDate}
                                onChange={(e) => setUpdate(it.id, { dueDate: e.target.value })}
                                className="rounded border border-slate-300 p-1"
                              />
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <button
                onClick={() => addNewMinute(area)}
                className="mt-2 rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                + Add new minute in {area}
              </button>
            </div>
          ))
        )}
      </div>

      {/* New minutes */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New minutes this meeting ({newMinutes.length})</h2>
          <button
            onClick={() => addNewMinute(data.areas[0] ?? "General")}
            className="rounded bg-brand-blue px-3 py-1 text-sm font-medium text-white"
          >
            + Add minute
          </button>
        </div>

        {newMinutes.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing new yet — add anything raised for the first time this meeting.</p>
        ) : (
          <div className="space-y-2">
            {newMinutes.map((m, i) => (
              <div key={i} className="rounded border-l-4 border-l-brand-blue bg-blue-50 p-2">
                <div className="mb-1 flex items-center gap-2">
                  <input
                    value={m.title}
                    onChange={(e) => setNewMinute(i, { title: e.target.value })}
                    placeholder="Title"
                    className="flex-1 rounded border border-slate-300 p-1 text-sm"
                  />
                  <button
                    onClick={() => removeNewMinute(i)}
                    className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
                <textarea
                  value={m.description}
                  onChange={(e) => setNewMinute(i, { description: e.target.value })}
                  rows={2}
                  placeholder="Description"
                  className="w-full rounded border border-slate-300 p-1 text-sm"
                />
                <div className="mt-1 grid grid-cols-2 gap-1 text-xs sm:grid-cols-5">
                  <input
                    value={m.area}
                    onChange={(e) => setNewMinute(i, { area: e.target.value })}
                    placeholder="Area"
                    className="rounded border border-slate-300 p-1"
                  />
                  <select
                    value={m.type}
                    onChange={(e) => setNewMinute(i, { type: e.target.value })}
                    className="rounded border border-slate-300 p-1"
                  >
                    {TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <select
                    value={m.status}
                    onChange={(e) => setNewMinute(i, { status: e.target.value })}
                    className="rounded border border-slate-300 p-1"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <select
                    value={m.assignedTo}
                    onChange={(e) => setNewMinute(i, { assignedTo: e.target.value })}
                    className="rounded border border-slate-300 p-1"
                  >
                    <option value="">— Unassigned —</option>
                    {members.map((mem) => (
                      <option key={mem.id} value={mem.displayName}>{mem.displayName}</option>
                    ))}
                  </select>
                  <input
                    type="date"
                    value={m.dueDate}
                    onChange={(e) => setNewMinute(i, { dueDate: e.target.value })}
                    className="rounded border border-slate-300 p-1"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* Actions */}
      <div className="flex items-center gap-2">
        <a href="/browse" className="rounded border border-slate-300 px-4 py-2 text-sm">Cancel</a>
        <button
          onClick={save}
          disabled={saving || !title.trim()}
          className="ml-auto rounded bg-gradient-to-r from-brand-pink to-brand-purple px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "✓ Save follow-up meeting"}
        </button>
      </div>
    </div>
  );
}
