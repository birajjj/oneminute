// Central Gemini client. All AI calls in the app go through this file
// so we can swap providers or add rate-limits/caching in one place later.
//
// SERVER-ONLY: this file must never be imported by a Client Component.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Gemini's free tier can transiently return 503 UNAVAILABLE ("high demand"),
// 429 (rate limit), or 500. These are worth retrying with backoff rather than
// failing the user's request outright.
const RETRYABLE_STATUS = new Set([429, 500, 503]);

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

// POSTs JSON to Gemini, retrying transient overload / rate-limit responses with
// exponential backoff. Returns the raw response body text on success.
async function postWithRetry(url: string, body: unknown, attempts = 4): Promise<string> {
  let lastErr = "Gemini request failed";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    if (resp.ok) return text;

    lastErr = `Gemini ${resp.status}: ${text}`;
    if (!RETRYABLE_STATUS.has(resp.status) || attempt === attempts - 1) {
      throw new Error(lastErr);
    }
    // Back off ~1s, 2s, 4s (+ jitter) before retrying.
    await sleep(1000 * 2 ** attempt + Math.random() * 250);
  }
  throw new Error(lastErr);
}

// ---------------------------------------------------------------------------
// Text generation with structured JSON output
// ---------------------------------------------------------------------------

interface GenerateJsonInput {
  prompt: string;
  schema: object;
  temperature?: number;
}

export async function generateJson<T = unknown>({
  prompt,
  schema,
  temperature = 0.3
}: GenerateJsonInput): Promise<{ data: T | null; raw: string }> {
  const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${apiKey()}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: 32768,
      responseMimeType: "application/json",
      responseSchema: schema
    }
  };

  const rawResponse = await postWithRetry(url, body);

  const parsed = JSON.parse(rawResponse) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  if (!text) return { data: null, raw: "" };

  try {
    return { data: JSON.parse(text) as T, raw: text };
  } catch {
    return { data: null, raw: text };
  }
}

// ---------------------------------------------------------------------------
// Audio transcription
//
// Small clips (<= 19 MB) go inline — base64 in the request, one round trip.
// Larger clips use the Files API: upload the bytes, wait until Gemini finishes
// processing them, then reference the file URI. The Files API allows ~2 GB /
// several hours, so it lifts the 20 MB inline ceiling for long recordings.
// Both paths are free on Gemini.
//
// In practice the Auto recorder segments meetings into ~10-minute clips, so the
// inline path handles almost everything; the Files API is the safety net for an
// oversized clip (e.g. a segment that grows long when a background tab throttles
// the segment timer, or a large file supplied directly).
// ---------------------------------------------------------------------------

const INLINE_AUDIO_LIMIT = 19 * 1024 * 1024; // 19 MB safety margin under Gemini's 20 MB
const UPLOAD_BASE_URL = "https://generativelanguage.googleapis.com/upload/v1beta";

const TRANSCRIBE_PROMPT =
  "Transcribe the following meeting audio verbatim. " +
  "Include every speaker turn. Do not summarize or add commentary. " +
  "Return only the transcript text.";

export async function transcribeAudio(
  audioBytes: ArrayBuffer,
  mimeType: string
): Promise<string> {
  if (audioBytes.byteLength === 0) throw new Error("empty audio payload");
  const mime = normalizeAudioMime(mimeType);

  return audioBytes.byteLength <= INLINE_AUDIO_LIMIT
    ? transcribeInline(audioBytes, mime)
    : transcribeViaFileApi(audioBytes, mime);
}

async function transcribeInline(audioBytes: ArrayBuffer, mime: string): Promise<string> {
  const base64 = arrayBufferToBase64(audioBytes);
  const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${apiKey()}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: TRANSCRIBE_PROMPT },
          { inline_data: { mime_type: mime, data: base64 } }
        ]
      }
    ],
    generationConfig: { temperature: 0.0, responseMimeType: "text/plain" }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`Gemini transcription ${resp.status}: ${raw}`);
  return extractText(raw);
}

async function transcribeViaFileApi(audioBytes: ArrayBuffer, mime: string): Promise<string> {
  const fileUri = await uploadToGemini(audioBytes, mime);
  const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${apiKey()}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: TRANSCRIBE_PROMPT },
          { file_data: { mime_type: mime, file_uri: fileUri } }
        ]
      }
    ],
    generationConfig: { temperature: 0.0, responseMimeType: "text/plain" }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`Gemini transcription (file) ${resp.status}: ${raw}`);
  return extractText(raw);
}

// Uploads bytes via the resumable Files API and returns the file URI once the
// file is ACTIVE. Gemini briefly reports PROCESSING for audio/video before the
// file becomes usable, so we poll status until it flips to ACTIVE.
async function uploadToGemini(audioBytes: ArrayBuffer, mime: string): Promise<string> {
  const numBytes = audioBytes.byteLength;

  // 1. Start a resumable upload session; Gemini returns the upload URL in a header.
  const startResp = await fetch(`${UPLOAD_BASE_URL}/files?key=${apiKey()}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(numBytes),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file: { display_name: "meeting-audio" } })
  });
  if (!startResp.ok) {
    throw new Error(`Gemini upload start ${startResp.status}: ${await startResp.text()}`);
  }
  const uploadUrl = startResp.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini upload: no upload URL in response");

  // 2. Upload all the bytes and finalize in one request.
  const upResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    body: audioBytes
  });
  if (!upResp.ok) {
    throw new Error(`Gemini upload ${upResp.status}: ${await upResp.text()}`);
  }

  type FileMeta = { uri?: string; name?: string; state?: string };
  let file = ((await upResp.json()) as { file?: FileMeta }).file;
  if (!file?.name) throw new Error("Gemini upload: malformed response");

  // 3. Poll until the file is ACTIVE (audio usually processes within seconds).
  let tries = 0;
  while (file.state === "PROCESSING" && tries < 60) {
    await sleep(1000);
    const g = await fetch(`${GEMINI_BASE_URL}/${file.name}?key=${apiKey()}`);
    if (!g.ok) throw new Error(`Gemini file status ${g.status}: ${await g.text()}`);
    file = (await g.json()) as FileMeta;
    tries++;
  }
  if (file.state !== "ACTIVE" || !file.uri) {
    throw new Error(`Gemini file not ready (state=${file.state ?? "unknown"})`);
  }
  return file.uri;
}

function extractText(raw: string): string {
  const parsed = JSON.parse(raw) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

function normalizeAudioMime(mime: string): string {
  if (!mime) return "audio/webm";
  const main = mime.split(";")[0].trim().toLowerCase();
  const supported = [
    "audio/wav", "audio/mp3", "audio/aiff", "audio/aac",
    "audio/ogg", "audio/flac", "audio/webm", "audio/mp4"
  ];
  return supported.includes(main) ? main : "audio/webm";
}
