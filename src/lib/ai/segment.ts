// Split a transcript into segments small enough that analysing one stays under
// Vercel's 60s function cap. Short transcripts stay a single segment, so a
// normal meeting behaves exactly like the old one-shot analysis.
//
// Splits on paragraph/line boundaries where possible so we never cut a sentence
// mid-way, and caps the segment COUNT so a pathologically long transcript can't
// spawn dozens of requests (it makes each segment larger instead).

// Kept deliberately small: analysis time is driven by how many minutes a
// segment yields (output tokens), and a dense meeting segment can blow past 60s.
// ~5k chars keeps each analysis comfortably inside Vercel's cap.
const DEFAULT_SEGMENT_CHARS = 5_000;
const MAX_SEGMENTS = 40;

export function segmentCount(transcript: string, targetChars = DEFAULT_SEGMENT_CHARS): number {
  return segmentTranscript(transcript, targetChars).length;
}

export function segmentTranscript(transcript: string, targetChars = DEFAULT_SEGMENT_CHARS): string[] {
  const text = transcript.trim();
  if (!text) return [];
  if (text.length <= targetChars) return [text];

  // Keep each segment under `size`, but grow `size` if that would exceed the cap.
  let size = targetChars;
  if (Math.ceil(text.length / size) > MAX_SEGMENTS) {
    size = Math.ceil(text.length / MAX_SEGMENTS);
  }

  // Prefer to break on blank lines, then single newlines, then a space, then a
  // hard cut — always at or before `size` so no segment exceeds it.
  const segments: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= size) {
      segments.push(text.slice(start).trim());
      break;
    }
    const window = text.slice(start, start + size);
    let cut =
      lastIndexBefore(window, "\n\n") ??
      lastIndexBefore(window, "\n") ??
      lastIndexBefore(window, " ") ??
      window.length;
    if (cut < size * 0.5) cut = window.length; // avoid tiny segments from an early boundary
    const piece = text.slice(start, start + cut).trim();
    if (piece) segments.push(piece);
    start += cut;
  }
  return segments.filter(Boolean);
}

function lastIndexBefore(s: string, needle: string): number | null {
  const i = s.lastIndexOf(needle);
  return i > 0 ? i + needle.length : null;
}
