"use client";

export default function BusyOverlay({
  message = "Please wait",
  detail = "Saving and committing your changes..."
}: {
  message?: string;
  detail?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      role="status"
      aria-live="polite"
      aria-label={`${message}. ${detail}`}
    >
      <div className="flex w-full max-w-sm items-center gap-3 rounded-lg border border-slate-200 bg-white p-5 shadow-xl">
        <div className="h-7 w-7 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-brand-purple" />
        <div>
          <div className="font-semibold text-slate-900">{message}</div>
          <div className="text-sm text-slate-500">{detail}</div>
        </div>
      </div>
    </div>
  );
}
