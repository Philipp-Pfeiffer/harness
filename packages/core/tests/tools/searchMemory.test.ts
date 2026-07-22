import { describe, it, expect, vi } from "vitest";
import { createSearchMemoryTool } from "../../src/tools/searchMemory.js";
import { loadTools } from "../../src/tools/registry.js";
import type { MemoryBackend, MemoryHit } from "../../src/core/memoryBackend.js";

function createFakeBackend(hits: MemoryHit[] = [], queryImpl?: (q: string, k?: number) => Promise<MemoryHit[]>): MemoryBackend {
  return {
    name: "fake",
    search: vi.fn(async () => []),
    query: queryImpl ?? vi.fn(async (q: string) => {
      void q;
      return hits;
    }),
    getAmbientHints: vi.fn(async () => []),
    write: vi.fn(async () => {}),
  };
}

const sampleHits: MemoryHit[] = [
  { source: "/proj/memory/arch.md", title: "Architecture", score: 0.92, content: "Architecture: MVC pattern with Ink" },
  { source: "/proj/memory/tools.md", title: "Tools", score: 0.81, content: "Tool registry pattern" },
];

describe("search_memory tool", () => {

  describe("A. Registry", () => {
    it("is present in loadTools() output", () => {
      const tools = loadTools(createFakeBackend());
      const found = tools.find((t) => t.name === "search_memory");
      expect(found).toBeDefined();
    });

    it("has exact name 'search_memory'", () => {
      const tools = loadTools(createFakeBackend());
      const found = tools.find((t) => t.name === "search_memory");
      expect(found?.name).toBe("search_memory");
    });

    it("schema requires 'query' as string", () => {
      const tools = loadTools(createFakeBackend());
      const found = tools.find((t) => t.name === "search_memory");
      // Typebox schema: check that 'query' is a required string property
      const params = found!.parameters as Record<string, unknown>;
      const properties = params.properties as Record<string, { type: string }>;
      expect(properties.query.type).toBe("string");
      const required = params.required as string[];
      expect(required).toContain("query");
    });
  });

  describe("B. Query forwarding", () => {
    it("calls memoryBackend.query() exactly once with the query", async () => {
      const backend = createFakeBackend(sampleHits);
      const tool = createSearchMemoryTool(backend);
      const result = await tool.execute({ query: "phase 2 memory" });

      expect(backend.query).toHaveBeenCalledOnce();
      expect(backend.query).toHaveBeenCalledWith("phase 2 memory", 8);
      expect(result.content).toContain("arch.md");
      expect(result.content).toContain("tools.md");
    });
  });

  describe("C. Query trim", () => {
    it("trims whitespace before forwarding to backend", async () => {
      const backend = createFakeBackend(sampleHits);
      const tool = createSearchMemoryTool(backend);
      await tool.execute({ query: "  ambient hook  " });

      expect(backend.query).toHaveBeenCalledWith("ambient hook", 8);
    });
  });

  describe("D. Empty results", () => {
    it("returns successful empty result without throwing", async () => {
      const backend = createFakeBackend([]);
      const tool = createSearchMemoryTool(backend);
      const result = await tool.execute({ query: "nonexistent topic" });

      expect(result.content).toContain("0 strong results");
      expect(result.content).not.toContain("error");
    });
  });

  describe("E. Missing backend / degraded mode", () => {
    it("returns graceful message when no memoryBackend provided", async () => {
      const tool = createSearchMemoryTool(undefined);
      const result = await tool.execute({ query: "anything" });

      expect(result.content).toContain("unavailable");
      expect(result.content).toContain("No memory backend configured");
    });

    it("does not throw in degraded mode", async () => {
      const tool = createSearchMemoryTool(undefined);
      await expect(tool.execute({ query: "anything" })).resolves.toBeDefined();
    });
  });

  describe("F. Backend error", () => {
    it("formats backend errors as tool result, does not swallow silently", async () => {
      const backend = createFakeBackend([], vi.fn(async () => {
        throw new Error("QMD store corrupted");
      }));
      const tool = createSearchMemoryTool(backend);
      const result = await tool.execute({ query: "anything" });

      expect(result.content).toContain("error");
      expect(result.content).toContain("QMD store corrupted");
    });
  });

  describe("G. No ambient-hint coupling", () => {
    it("does not call getAmbientHints()", async () => {
      const backend = createFakeBackend(sampleHits);
      const tool = createSearchMemoryTool(backend);
      await tool.execute({ query: "architecture" });

      expect(backend.getAmbientHints).not.toHaveBeenCalled();
    });
  });

  describe("H. Snippet format", () => {
    it("returns title, path, score, and snippet — never full file bodies", async () => {
      const backend = createFakeBackend([
        { source: "/proj/memory/daily.md", title: "Daily Tape", score: 0.92, content: "Line one.\nLine two about the query term.\nLine three.\nLine four.\nLine five." },
      ]);
      const tool = createSearchMemoryTool(backend);
      const result = await tool.execute({ query: "query term" });

      expect(result.content).toContain("Title: Daily Tape");
      expect(result.content).toContain("Path: /proj/memory/daily.md");
      expect(result.content).toContain("Score:");
      expect(result.content).toContain("Snippet:");
      expect(result.content).not.toContain("Line five");
    });

    it("advises lazy loading via read_file(path)", async () => {
      const backend = createFakeBackend(sampleHits);
      const tool = createSearchMemoryTool(backend);
      const result = await tool.execute({ query: "architecture" });

      expect(result.content).toContain("read_file(path)");
    });
  });

  describe("I. Relevance threshold", () => {
    it("filters hits below the strong threshold", async () => {
      const backend = createFakeBackend([
        { source: "/proj/memory/strong.md", title: "Strong", score: 0.92, content: "Very relevant content" },
        { source: "/proj/memory/weak.md", title: "Weak", score: 0.009, content: "Barely relevant content" },
      ]);
      const tool = createSearchMemoryTool(backend);
      const result = await tool.execute({ query: "relevant" });

      expect(result.content).toContain("strong.md");
      expect(result.content).not.toContain("weak.md");
    });

    it("returns 'no strong results' when all hits are below threshold", async () => {
      const backend = createFakeBackend([
        { source: "/proj/memory/noise.md", title: "Noise", score: 0.009, content: "Unrelated content" },
      ]);
      const tool = createSearchMemoryTool(backend);
      const result = await tool.execute({ query: "anything" });

      expect(result.content).toContain("0 strong results");
      expect(result.content).toContain("No strongly relevant notes found");
    });
  });

  describe("J. Output budget", () => {
    it("keeps a previously full-file query under 6k characters", async () => {
      const hugeBody = "Daily entry line.\n".repeat(2000);
      const backend = createFakeBackend([
        { source: "/proj/memory/daily.md", title: "Daily Tape", score: 0.92, content: hugeBody },
      ]);
      const tool = createSearchMemoryTool(backend);
      const result = await tool.execute({ query: "daily entry" });

      expect(result.content.length).toBeLessThan(6000);
      expect(result.content).toContain("Snippet:");
      expect(result.content).not.toContain(hugeBody);
    });

    it("caps each snippet to roughly 500 characters", async () => {
      const longParagraph = "word ".repeat(300);
      const backend = createFakeBackend([
        { source: "/proj/memory/long.md", title: "Long Note", score: 0.92, content: longParagraph },
      ]);
      const tool = createSearchMemoryTool(backend);
      const result = await tool.execute({ query: "word" });

      const snippetMatch = result.content.match(/Snippet:\n([\s\S]*?)(?=\n\n|\n\[|$)/);
      expect(snippetMatch).toBeTruthy();
      const snippet = snippetMatch![1]!;
      expect(snippet.length).toBeLessThanOrEqual(520);
    });
  });
});
