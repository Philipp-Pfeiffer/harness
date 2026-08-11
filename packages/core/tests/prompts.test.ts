import { describe, it, expect } from "vitest";
import { prompt } from "../src/prompts.js";

describe("prompt()", () => {
  it("loads an existing prompt and substitutes variables", () => {
    const result = prompt("steer-annotation", {
      userInput: "test input",
      timestamp: "2026-05-25T10:00:00.000Z",
    });
    expect(result).toContain("test input");
    expect(result).not.toContain("{{");
    expect(result).not.toContain("<!--");
  });

  it("returns empty string for missing variable instead of throwing", () => {
    const result = prompt("steer-annotation", {
      timestamp: "2026-05-25T10:00:00.000Z",
      // userInput is missing
    } as any);
    // Missing variable should be replaced with empty string
    expect(result).not.toContain("{{userInput}}");
  });

  it("returns fallback prompt for missing prompt file", () => {
    const result = prompt("does-not-exist", {});
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("{{");
  });

  it("system-prompt exists and strips HTML comments", () => {
    const result = prompt("system-prompt");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("<!--");
  });

  describe("system-prompt: inbox append contract (Step 5)", () => {
    it("references the inbox path via {{inboxPath}} substitution", () => {
      const result = prompt("system-prompt", { inboxPath: "/custom/inbox.md" });
      expect(result).toContain("/custom/inbox.md");
      expect(result).not.toContain("{{inboxPath}}");
    });

    it("instructs to use the edit tool (not a dedicated remember tool)", () => {
      const result = prompt("system-prompt", { inboxPath: "/proj/memory/_inbox.md" });
      // "edit" is language-independent in the tool name context
      expect(result.toLowerCase()).toContain("edit");
    });
  });
});
