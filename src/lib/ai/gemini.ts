// Central Gemini client. All AI calls in the app go through this file
// so we can swap providers or add rate-limits/caching in one place later.
//
// SERVER-ONLY: this file must never be imported by a Client Component.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
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

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const rawResponse = await resp.text();
  if (!resp.ok) {
    throw new Error(`Gemini ${resp.status}: ${rawResponse}`);
  }

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
// Audio transcription (Gemini can consume inline base64 audio directly)
// ---------------------------------------------------------------------------

const INLINE_AUDIO_LIMIT = 19 * 1024 * 1024; // 19 MB safety margin under Gemini's 20 MB

export async function transcribeAudio(
  audioBytes: ArrayBuffer,
  mimeType: string
): Promise<string> {
  if (audioBytes.byteLength === 0) throw new Error("empty audio payload");
  if (audioBytes.byteLength > INLINE_AUDIO_LIMIT) {
    throw new Error(
      `audio is ${(audioBytes.byteLength / (1024 * 1024)).toFixed(1)} MB — inline Gemini transcription supports up to 19 MB`
    );
  }

  const normalizedMime = normalizeAudioMime(mimeType);
  const base64 = arrayBufferToBase64(audioBytes);

  const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${apiKey()}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Transcribe the following meeting audio verbatim. " +
              "Include every speaker turn. Do not summarize or add commentary. " +
              "Return only the transcript text."
          },
          { inline_data: { mime_type: normalizedMime, data: base64 } }
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

  const parsed = JSON.parse(raw) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
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
