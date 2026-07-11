import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.js";
import type { MemoryBackend, MemoryHit } from "../core/memoryBackend.js";

const SearchMemoryArgs = Type.Object({
  query: Type.String({
    minLength: 1,
    description:
      "Natural-language search query for long-term memory (personal notes, sources). Returns ranked results with title, path, snippet, and score. Load full notes via read_file(path).",
  }),
});

const DEFAULT_K = 8;

/** RRF-space equivalent of the ambient-hook cosine > 0.5 threshold.
 * With k=60 and two lists, max score ≈ 2/61 ≈ 0.033. A hit must be near
 * the top of at least one list (or strong in both) to pass.
 */
const MIN_SCORE = 0.015;

const MAX_SNIPPET_LENGTH = 500;
const MAX_OUTPUT_CHARS = 5500;

function extractSnippet(content: string, query: string): string {
  if (!content) return "";

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const lines = content.split("\n");

  // Find the line that matches the most query terms.
  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const lineLower = line.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lineLower.includes(term) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  // Pull 2–3 lines around the best match.
  const start = Math.max(0, bestIndex - 1);
  const end = Math.min(lines.length, bestIndex + 3);
  const snippet = lines
    .slice(start, end)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .join("\n");

  if (!snippet) {
    return content.slice(0, MAX_SNIPPET_LENGTH).trim();
  }
  if (snippet.length <= MAX_SNIPPET_LENGTH) {
    return snippet;
  }
  return snippet.slice(0, MAX_SNIPPET_LENGTH).trimEnd() + "…";
}

function formatHit(hit: MemoryHit, query: string, index: number): string {
  const snippet = extractSnippet(hit.content, query);
  const lines = [
    `[${index + 1}]`,
    `Title: ${hit.title}`,
    `Path: ${hit.source}`,
    `Score: ${hit.score.toFixed(3)}`,
  ];
  if (snippet) {
    lines.push(`Snippet:\n${snippet}`);
  }
  return lines.join("\n");
}

function formatResults(query: string, hits: MemoryHit[]): string {
  if (hits.length === 0) {
    return "--- memory search: 0 strong results ---\nNo strongly relevant notes found. Try a different query.";
  }

  const header = `--- memory search: ${hits.length} result${hits.length === 1 ? "" : "s"} ---`;
  const sections = hits.map((h, i) => formatHit(h, query, i));
  const lazyHint = "\n\nLoad full notes via read_file(path).";

  let body = sections.join("\n\n");
  let result = `${header}\n${body}${lazyHint}`;

  if (result.length > MAX_OUTPUT_CHARS) {
    const available = MAX_OUTPUT_CHARS - header.length - lazyHint.length - 50;
    body = body.slice(0, Math.max(0, available)).trimEnd() + "\n…";
    result = `${header}\n${body}${lazyHint}`;
  }

  return result;
}

/**
 * Creates the search_memory tool with an optional MemoryBackend injected via closure.
 *
 * The tool is read-only: it calls MemoryBackend.query() (L4 hybrid, no LLM)
 * and returns a compact ranked list of {title, path, snippet, score}.
 * Full notes are lazy-loaded via read_file(path). No writes, no message mutation.
 *
 * If no backend is provided (degraded mode), the tool returns a graceful message
 * instead of throwing — consistent with the StubBackend pattern.
 */
export function createSearchMemoryTool(memoryBackend?: MemoryBackend): Tool<typeof SearchMemoryArgs> {
  return {
    name: "search_memory",
    description:
      "Search your long-term memory (personal notes in memory/ and sources/). Returns a ranked list with title, path, snippet, and score. Full notes can be loaded lazily via read_file(path). Read-only.",
    parameters: SearchMemoryArgs,
    async execute(args) {
      const query = args.query.trim();

      if (!query) {
        return "--- memory search: 0 strong results ---\nQuery was empty after trimming.";
      }

      if (!memoryBackend) {
        return "--- memory search: unavailable ---\nNo memory backend configured. Memory search is not available.";
      }

      try {
        const hits = await memoryBackend.query(query, DEFAULT_K);
        const strong = hits.filter((h) => h.score >= MIN_SCORE);
        return formatResults(query, strong);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `--- memory search: error ---\nFailed to search memory: ${message}`;
      }
    },
  };
}
