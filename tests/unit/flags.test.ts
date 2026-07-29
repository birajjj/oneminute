import { describe, it, expect } from "vitest";
import {
  normalizeFlag,
  isMinuteFlag,
  MINUTE_FLAGS,
  FLAG_BADGE_CLASS
} from "@/lib/minutes/flags";

describe("normalizeFlag", () => {
  it("returns the canonical value for each known flag", () => {
    for (const f of MINUTE_FLAGS) {
      expect(normalizeFlag(f)).toBe(f);
    }
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeFlag("decision")).toBe("Decision");
    expect(normalizeFlag("  SCOPE  ")).toBe("Scope");
    expect(normalizeFlag("Governance")).toBe("Governance");
  });

  it("treats blank / empty-sentinel values as unflagged", () => {
    expect(normalizeFlag("")).toBeNull();
    expect(normalizeFlag("   ")).toBeNull();
    expect(normalizeFlag(null)).toBeNull();
    expect(normalizeFlag(undefined)).toBeNull();
  });

  it("rejects unknown values", () => {
    expect(normalizeFlag("Risk")).toBeNull();
    expect(normalizeFlag("todo")).toBeNull();
  });
});

describe("isMinuteFlag", () => {
  it("accepts known flags (any casing) and rejects anything else", () => {
    expect(isMinuteFlag("Decision")).toBe(true);
    expect(isMinuteFlag("scope")).toBe(true);
    expect(isMinuteFlag("Risk")).toBe(false);
    expect(isMinuteFlag(42)).toBe(false);
    expect(isMinuteFlag(null)).toBe(false);
  });
});

describe("FLAG_BADGE_CLASS", () => {
  it("has a style for every flag", () => {
    for (const f of MINUTE_FLAGS) {
      expect(FLAG_BADGE_CLASS[f]).toBeTruthy();
    }
  });
});
