// "What did I miss?" — compares the minutes a person actually wrote against the
// transcript and proposes only what is genuinely absent.
//
// This is deliberately NOT the auto-analyser: the human's minutes are the
// standard, and the AI's job is to fill gaps in them, not to replace them. That
// keeps the boss's judgement (what deserves recording, how it's worded) in
// charge, and the suggestions read as "you may also want…".
//
// SERVER-ONLY.

import { generateJson } from "./provider";

export interface CapturedMinute {
  title: string;
  description: string;
  type: string; // label
}

export interface Suggestion {
  title: string;
  description: string;
  minuteType: string; // Note | To-Do | Action | Devops
  area: string;
  reason: string; // why it looks missing — shown to the user, never saved
}

const responseSchema = {
  type: "OBJECT",
  properties: {
    suggestions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          description: { type: "STRING" },
          minuteType: { type: "STRING" },
          area: { type: "STRING" },
          reason: { type: "STRING" }
        },
        required: ["title"]
      }
    }
  },
  required: ["suggestions"]
};

const TYPES = ["Note", "To-Do", "Action", "Devops"];

export async function suggestMissing(
  transcript: string,
  captured: CapturedMinute[],
  opts?: {
    areas?: string[];
    styleProfile?: string | null;
    examples?: { title: string; description: string; type: string }[];
    declined?: string[];
  }
): Promise<Suggestion[]> {
  const lines: string[] = [];
  lines.push("A person took the minutes below BY HAND during a meeting. You are reviewing their");
  lines.push("work against the transcript to catch anything they missed.");
  // The learned house style goes FIRST: it governs both what is worth suggesting
  // and how the suggestion should read, so it must frame everything after it.
  if (opts?.styleProfile?.trim()) {
    lines.push("");
    lines.push("### HOW THIS TEAM WRITES MINUTES");
    lines.push("Learned from the minutes they have already written on this project. Anything you");
    lines.push("suggest must match it — in what is worth recording, and in how it is worded.");
    lines.push(opts.styleProfile.trim());
  }
  lines.push("");
  lines.push("Return `suggestions`: things that were genuinely discussed in the transcript but are");
  lines.push("NOT represented in their minutes. For each: title, description, minuteType");
  lines.push("(Note | To-Do | Action | Devops), area, and `reason` — one short line saying why you");
  lines.push("think it is missing.");
  lines.push("");
  lines.push("BE CONSERVATIVE. Their minutes are the standard — you are filling gaps, not rewriting:");
  lines.push("- If something is already covered by one of their minutes, even loosely or in different");
  lines.push("  words, do NOT suggest it. Overlap is the most common mistake — check carefully.");
  lines.push("- Skip small talk, scheduling chatter and asides that nobody would minute.");
  lines.push("- Match the STYLE of the minutes they wrote: same level of detail and tone.");
  lines.push("- Group by topic: one suggestion per real subject, description 1-3 sentences.");
  lines.push("- Prefer FEW, high-value suggestions. Returning an empty list is a perfectly good");
  lines.push("  answer when they captured everything that mattered.");
  if (opts?.areas?.length) {
    lines.push(`- Reuse one of these existing areas where it fits: ${opts.areas.map((a) => `"${a}"`).join(", ")}.`);
  }
  // Showing beats telling: real minutes from this project are a stronger guide
  // to voice and granularity than any description of them.
  if (opts?.examples?.length) {
    lines.push("");
    lines.push("### HOW THEIR MINUTES READ (real examples from this project)");
    lines.push("Write any suggestion so it would sit naturally beside these.");
    for (const e of opts.examples) {
      lines.push(`- (${e.type}) ${e.title}`);
      lines.push(`  ${e.description}`);
    }
  }

  // The clearest statement of what this team does not consider worth recording.
  if (opts?.declined?.length) {
    lines.push("");
    lines.push("### ALREADY OFFERED AND DECLINED");
    lines.push("They were shown these before and chose not to record them. Do not offer anything");
    lines.push("of this kind again unless the transcript makes it materially more significant.");
    for (const d of opts.declined) lines.push(`- ${d}`);
  }

  lines.push("");
  lines.push("### MINUTES THEY ALREADY WROTE");
  if (captured.length === 0) {
    lines.push("(none yet — they have not written anything for this part)");
  } else {
    for (const m of captured) {
      const d = m.description ? ` — ${m.description}` : "";
      lines.push(`- (${m.type}) ${m.title}${d}`);
    }
  }
  lines.push("");
  lines.push("### TRANSCRIPT");
  lines.push(transcript);

  const { data } = await generateJson<{ suggestions: Suggestion[] }>({
    prompt: lines.join("\n"),
    schema: responseSchema,
    temperature: 0.3
  });

  return (data?.suggestions ?? [])
    .filter((s) => s && s.title && s.title.trim())
    .map((s) => ({
      title: s.title.trim(),
      description: (s.description || "").trim(),
      minuteType: TYPES.includes(s.minuteType) ? s.minuteType : "Note",
      area: (s.area || "General").trim() || "General",
      reason: (s.reason || "").trim()
    }));
}
