import { describe, it, expect } from "vitest";

import { composeProfilePrompt } from "../../src/core/profilePrompt.js";

/**
 * Composition contract for profile sessions:
 * bare base prompt + persona + optional core memory + optional hot-set.
 */

describe("composeProfilePrompt", () => {
  it("composes base + persona + core memory + hot-set for a full-access profile", () => {
    const result = composeProfilePrompt({
      basePrompt: "BASE",
      persona: "PERSONA",
      coreMemoryRaw: "CORE",
      hotSetBlock: "HOTSET",
    });
    expect(result).toBe(
      "BASE\n\nPERSONA\n\n<core_memory>\nCORE\n</core_memory>\n\nHOTSET",
    );
  });

  it("reproduces the previous daemon prompt for the default profile (plus bare prefix)", () => {
    // The default profile's persona is the former system-prompt.md content;
    // everything after the bare base block must match the old composition
    // (persona + core memory block + hot-set) exactly.
    const result = composeProfilePrompt({
      basePrompt: "BASE",
      persona: "OLD_SYSTEM_PROMPT",
      coreMemoryRaw: "CORE",
      hotSetBlock: "HOTSET",
    });
    const withoutBare = result.slice("BASE\n\n".length);
    expect(withoutBare).toBe(
      "OLD_SYSTEM_PROMPT\n\n<core_memory>\nCORE\n</core_memory>\n\nHOTSET",
    );
  });

  it("omits the core memory block when the core zone is not granted", () => {
    const result = composeProfilePrompt({
      basePrompt: "BASE",
      persona: "PERSONA",
      coreMemoryRaw: "CORE",
      hotSetBlock: "HOTSET",
      memoryZones: ["notes"],
    });
    expect(result).toBe("BASE\n\nPERSONA\n\nHOTSET");
    expect(result).not.toContain("core_memory");
  });

  it("omits the hot-set when skills are disabled", () => {
    const result = composeProfilePrompt({
      basePrompt: "BASE",
      persona: "PERSONA",
      coreMemoryRaw: "CORE",
      hotSetBlock: "HOTSET",
      skillsHotSet: false,
    });
    expect(result).toBe("BASE\n\nPERSONA\n\n<core_memory>\nCORE\n</core_memory>");
  });

  it("keeps an empty core memory block (previous daemon behavior) but drops an empty hot-set", () => {
    const result = composeProfilePrompt({
      basePrompt: "BASE",
      persona: "PERSONA",
      hotSetBlock: "",
    });
    expect(result).toBe("BASE\n\nPERSONA\n\n<core_memory></core_memory>");
  });

  it("composes a minimal prompt without memory zones and skills", () => {
    const result = composeProfilePrompt({
      basePrompt: "BASE",
      persona: "PERSONA",
      memoryZones: [],
      skillsHotSet: false,
    });
    expect(result).toBe("BASE\n\nPERSONA");
  });
});
