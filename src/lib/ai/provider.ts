// Analysis-provider dispatcher. Only the TEXT ANALYSIS is switchable; audio
// transcription always uses Gemini (Claude can't transcribe audio).
//
//   AI_PROVIDER=anthropic -> Claude   (falls back to Gemini if no key is set)
//   anything else / unset -> Gemini   (free tier)
//
// Both providers expose the same { prompt, schema, temperature } -> { data, raw }
// shape, so callers don't care which one runs.
//
// SERVER-ONLY.

import { generateJson as generateJsonGemini } from "./gemini";
import { generateJsonAnthropic, anthropicConfigured } from "./anthropic";

interface GenerateJsonInput {
  prompt: string;
  schema: object;
  temperature?: number;
}

export async function generateJson<T = unknown>(
  input: GenerateJsonInput
): Promise<{ data: T | null; raw: string }> {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();

  if (provider === "anthropic" && anthropicConfigured()) {
    return generateJsonAnthropic<T>(input);
  }
  // Default, and the safety net if Anthropic is selected but no key is present.
  return generateJsonGemini<T>(input);
}
