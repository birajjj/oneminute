// Saves the meeting transcript as a readable text file — speaker-attributed
// dialogue with a small header, so it can be filed or emailed as the record of
// what was actually said (distinct from the minutes, which are the decisions).
//
// Client-only (uses Blob + a temporary anchor).

function safeFileName(s: string): string {
  return (s || "meeting").replace(/[^\w\d\-. ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
}

export function buildTranscriptText(opts: {
  title: string;
  date: string; // ISO or datetime-local
  projectName?: string | null;
  transcript: string;
}): string {
  const when = (() => {
    const d = new Date(opts.date);
    return isNaN(d.getTime())
      ? opts.date
      : d.toLocaleString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });
  })();

  const head = [
    opts.title || "Meeting transcript",
    opts.projectName ? `Project: ${opts.projectName}` : "",
    when ? `Date: ${when}` : "",
    "",
    "TRANSCRIPT",
    "".padEnd(60, "-"),
    ""
  ].filter((l) => l !== null);

  // Blank line between speaker turns so it stays readable in any text editor.
  const body = opts.transcript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n\n");

  return `${head.join("\n")}${body}\n`;
}

export function downloadTranscript(opts: {
  title: string;
  date: string;
  projectName?: string | null;
  transcript: string;
}): void {
  const text = buildTranscriptText(opts);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFileName(opts.title)}-transcript.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
