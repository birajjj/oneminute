// Claude (Anthropic) client for the ANALYSIS step. Mirrors the shape of
// gemini.ts's generateJson so the provider dispatcher can swap between them.
// Audio transcription stays on Gemini — the Claude API doesn't transcribe audio.
//
// SERVER-ONLY: never import from a Client Component.

import Anthropic from "@anthropic-ai/sdk";

// Default to Sonnet 5 — excellent at structured extraction, cheaper/faster than
// Opus for this task. Override with ANTHROPIC_MODEL (e.g. "claude-opus-5").
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
// 8000 comfortably fits ~30 concise minutes and bounds worst-case generation
// time so a request stays within the serverless 60s limit. Raise via env only
// if you move to a plan with a longer function timeout (e.g. Vercel Pro = 300s).
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 8000);

// Extended thinking gives smarter follow-up reasoning but costs latency + output
// tokens. Off by default so a long meeting stays within the serverless 60s
// limit; set ANTHROPIC_THINKING=adaptive to turn it on.
const USE_THINKING = process.env.ANTHROPIC_THINKING === "adaptive";

const SYSTEM_PROMPT =
  "You are a precise meeting-minutes analysis engine. You read a meeting " +
  "transcript plus existing project/meeting context and return a single JSON " +
  "object describing the project, meeting, and minutes. Return valid JSON only.";

export function anthropicConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  // The SDK reads ANTHROPIC_API_KEY from the environment automatically.
  // maxRetries makes transient overloads (429 / 500 / 503 / 529) retry with backoff.
  client ??= new Anthropic({ maxRetries: 3 });
  return client;
}

interface GenerateJsonInput {
  prompt: string;
  schema?: object;      // accepted for parity with the Gemini signature; unused here
  temperature?: number; // ignored — the Claude 5 models reject temperature
}

export async function generateJsonAnthropic<T = unknown>({
  prompt
}: GenerateJsonInput): Promise<{ data: T | null; raw: string }> {
  const anthropic = getClient();

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
    ],
    messages: [
      {
        role: "user",
        content:
          prompt +
          "\n\n### OUTPUT\nRespond with ONLY a single valid JSON object as " +
          "described above. No markdown, no code fences, no commentary."
      }
    ]
  };
  if (USE_THINKING) params.thinking = { type: "adaptive" };

  const response = await anthropic.messages.create(params);

  // Concatenate every text block; thinking blocks (if any) are ignored.
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (!text) return { data: null, raw: "" };

  const json = extractJson(text);
  try {
    return { data: JSON.parse(json) as T, raw: text };
  } catch {
    return { data: null, raw: text };
  }
}

// Claude returns clean JSON when instructed, but strip any code fences and
// isolate the outermost object as a safety net.
function extractJson(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return t.slice(first, last + 1);
  return t;
}
