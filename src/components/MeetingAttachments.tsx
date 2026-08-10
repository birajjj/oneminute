"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface AttachmentMeta {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string; // ISO
}

const MAX_BYTES = 4 * 1024 * 1024;

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(contentType: string, name: string) {
  const t = contentType.toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (t.includes("pdf") || ext === "pdf") return "📕";
  if (t.startsWith("image/")) return "🖼️";
  if (t.includes("sheet") || t.includes("excel") || ext === "csv" || ext === "xlsx") return "📊";
  if (t.includes("word") || ext === "doc" || ext === "docx") return "📝";
  if (t.includes("zip") || ext === "zip") return "🗜️";
  return "📄";
}

export default function MeetingAttachments({
  meetingId,
  attachments,
  canEdit
}: {
  meetingId: string;
  attachments: AttachmentMeta[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = ""; // allow re-picking the same file
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("That file is over the 4 MB limit.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/meetings/${meetingId}/attachments`, {
        method: "POST",
        body: fd
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Upload failed");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Remove this attachment?")) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/attachments/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-sm">
      <div className="mb-1 flex items-center gap-2 text-slate-500">
        <span>📎 Attachments</span>
        {attachments.length > 0 && <span className="text-xs text-slate-400">({attachments.length})</span>}
      </div>

      {attachments.length === 0 ? (
        <p className="text-slate-400">No documents attached.</p>
      ) : (
        <ul className="space-y-1">
          {attachments.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5"
            >
              <a
                href={`/api/attachments/${a.id}`}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
                title="Open in a new tab"
              >
                <span aria-hidden>{fileIcon(a.contentType, a.fileName)}</span>
                <span className="truncate font-medium text-slate-700">{a.fileName}</span>
              </a>
              <span className="shrink-0 text-xs text-slate-400">{fmtSize(a.size)}</span>
              {canEdit && (
                <button
                  onClick={() => onDelete(a.id)}
                  disabled={busy}
                  className="shrink-0 rounded px-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  title="Remove"
                  aria-label="Remove attachment"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="mt-2">
          <input ref={inputRef} type="file" onChange={onPick} disabled={busy} className="hidden" />
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="rounded border border-dashed border-brand-blue px-3 py-1.5 text-sm font-medium text-brand-blue hover:bg-blue-50 disabled:opacity-50"
          >
            {busy ? "Uploading…" : "+ Attach a document"}
          </button>
          <span className="ml-2 text-xs text-slate-400">up to 4 MB</span>
        </div>
      )}

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
