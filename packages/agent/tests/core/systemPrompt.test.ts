import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/core/systemPrompt.js";

describe("buildSystemPrompt", () => {
  it("returns base prompt plus core memory block when no web tools are active", () => {
    const result = buildSystemPrompt({
      basePrompt: "Base prompt text",
      coreMemoryRaw: "Some core memory",
      activeToolNames: ["readFile", "exec"],
    });
    expect(result).toContain("Base prompt text");
    expect(result).toContain("<core_memory>");
    expect(result).toContain("Some core memory");
    expect(result).not.toContain("UNTRUSTED DATA");
  });

  it("injects web-content-safety layer when web_fetch is active", () => {
    const result = buildSystemPrompt({
      basePrompt: "Base prompt text",
      activeToolNames: ["readFile", "web_fetch"],
    });
    expect(result).toContain("Base prompt text");
    expect(result).toContain("UNTRUSTED DATA");
    expect(result).toContain("<web_content url=\"...\" untrusted=\"true\">");
  });

  it("injects web-content-safety layer when web_search is active", () => {
    const result = buildSystemPrompt({
      basePrompt: "Base prompt text",
      activeToolNames: ["web_search"],
    });
    expect(result).toContain("UNTRUSTED DATA");
  });

  it("does not duplicate safety layer if both web tools are active", () => {
    const result = buildSystemPrompt({
      basePrompt: "Base prompt text",
      activeToolNames: ["web_fetch", "web_search"],
    });
    const matches = result.match(/UNTRUSTED DATA/g);
    expect(matches?.length).toBe(1);
  });
});
