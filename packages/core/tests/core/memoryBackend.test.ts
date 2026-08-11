import { describe, it, expect } from "vitest";
import { formatMemoryHint, type AmbientHint } from "../../src/core/memoryBackend.js";

describe("formatMemoryHint", () => {
  it("returns null for 0 hits", () => {
    expect(formatMemoryHint([])).toBeNull();
  });

  it("formats Top-1 with Title, Path, and Snippet", () => {
    const hits: AmbientHint[] = [
      { title: "Architecture Notes", path: "/proj/memory/arch.md", score: 0.92, snippet: "Use MVC pattern\nKeep controllers thin" },
    ];
    const result = formatMemoryHint(hits);
    expect(result).toContain("<memory_hint>");
    expect(result).toContain("[Top-1]");
    expect(result).toContain("Title: Architecture Notes");
    expect(result).toContain("Path: /proj/memory/arch.md");
    expect(result).toContain("Snippet: Use MVC pattern\nKeep controllers thin");
    expect(result).toContain("</memory_hint>");
  });

  it("formats Top-2/Top-3 without Snippet", () => {
    const hits: AmbientHint[] = [
      { title: "First", path: "/proj/memory/first.md", score: 0.92, snippet: "First snippet" },
      { title: "Second", path: "/proj/memory/second.md", score: 0.85, snippet: "Second snippet" },
      { title: "Third", path: "/proj/memory/third.md", score: 0.78, snippet: "Third snippet" },
    ];
    const result = formatMemoryHint(hits);
    expect(result).toContain("[Top-1]");
    expect(result).toContain("Snippet: First snippet");

    expect(result).toContain("[Top-2]");
    expect(result).not.toMatch(/\[Top-2\][\s\S]*?Snippet:/);

    expect(result).toContain("[Top-3]");
    expect(result).not.toMatch(/\[Top-3\][\s\S]*?Snippet:/);
  });

  it("omits Snippet line when Top-1 has no snippet", () => {
    const hits: AmbientHint[] = [
      { title: "No Snippet", path: "/proj/memory/nosnippet.md", score: 0.9 },
    ];
    const result = formatMemoryHint(hits);
    expect(result).toContain("[Top-1]");
    expect(result).toContain("Title: No Snippet");
    expect(result).not.toContain("Snippet:");
  });
});
