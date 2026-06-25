import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.js";
import type { MemoryBackend, MemoryHit } from "../core/memoryBackend.js";

const SearchMemoryArgs = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Natural-language search query for long-term memory (personal notes, sources). Returns ranked results with title, path, score, and snippet.",
  }),
});

const DEFAULT_K = 10;

function formatHit(hit: MemoryHit, index: number): string {
  const lines = [
    `[${index + 1}]`,
    `Path: ${hit.source}`,
    `Score: ${hit.score.toFixed(3)}`,
  ];
  if (hit.content) {
    lines.push(`Content: ${hit.content}`);
  }
  return lines.join("\n");
}

function formatResults(hits: MemoryHit[]): string {
  if (hits.length === 0) {
    return "--- memory search: 0 results ---\nNo matching notes found.";
  }
  const body = hits.map((h, i) => formatHit(h, i)).join("\n\n");
  return `--- memory search: ${hits.length} result${hits.length === 1 ? "" : "s"} ---\n${body}`;
}

/**
 * Creates the search_memory tool with an optional MemoryBackend injected via closure.
 *
 * The tool is read-only: it calls MemoryBackend.query() (L4 hybrid + rerank)
 * and returns structured text results. No writes, no message mutation.
 *
 * If no backend is provided (degraded mode), the tool returns a graceful message
 * instead of throwing — consistent with the StubBackend pattern.
 */
export function createSearchMemoryTool(memoryBackend?: MemoryBackend): Tool<typeof SearchMemoryArgs> {
  return {
    name: "search_memory",
    description:
      "Search your long-term memory (personal notes in memory/ and sources/). Uses hybrid retrieval (keyword + semantic + rerank). Returns ranked results with path, score, and content. Use this when you need to recall stored information. Read-only.",
    parameters: SearchMemoryArgs,
    async execute(args) {
      const query = args.query.trim();

      if (!query) {
        return "--- memory search: 0 results ---\nQuery was empty after trimming.";
      }

      if (!memoryBackend) {
        return "--- memory search: unavailable ---\nNo memory backend configured. Memory search is not available.";
      }

      try {
        const hits = await memoryBackend.query(query, DEFAULT_K);
        return formatResults(hits);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `--- memory search: error ---\nFailed to search memory: ${message}`;
      }
    },
  };
}
