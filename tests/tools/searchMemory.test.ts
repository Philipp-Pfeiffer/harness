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
  { source: "/proj/memory/arch.md", score: 0.92, content: "Architecture: MVC pattern with Ink" },
  { source: "/proj/memory/tools.md", score: 0.81, content: "Tool registry pattern" },
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
      expect(backend.query).toHaveBeenCalledWith("phase 2 memory", 10);
      expect(result).toContain("arch.md");
      expect(result).toContain("tools.md");
    });
  });

  describe("C. Query trim", () => {
    it("trims whitespace before forwarding to backend", async () => {
      const backend = createFakeBackend(sampleHits);
      const tool = createSearchMemoryTool(backend);
      await tool.execute({ query: "  ambient hook  " });

      expect(backend.query).toHaveBeenCalledWith("ambient hook", 10);
    });
  });

  describe("D. Empty results", () => {
    it("returns successful empty result without throwing", async () => {
      const backend = createFakeBackend([]);
      const tool = createSearchMemoryTool(backend);
      const result = await tool.execute({ query: "nonexistent topic" });

      expect(result).toContain("0 results");
      expect(result).not.toContain("error");
    });
  });

  describe("E. Missing backend / degraded mode", () => {
    it("returns graceful message when no memoryBackend provided", async () => {
      const tool = createSearchMemoryTool(undefined);
      const result = await tool.execute({ query: "anything" });

      expect(result).toContain("unavailable");
      expect(result).toContain("No memory backend configured");
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

      expect(result).toContain("error");
      expect(result).toContain("QMD store corrupted");
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
});
