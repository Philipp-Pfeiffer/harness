import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { QMDStore, SearchResult } from "@tobilu/qmd";
import type { MemoryBackend, MemoryHit, MemoryEntry, AmbientHint } from "./memoryBackend.js";

export interface QmdBackendOptions {
  /** Default number of results. */
  defaultK?: number;
}

function searchResultToHit(r: SearchResult): MemoryHit {
  return {
    source: r.filepath,
    score: r.score,
    content: (r.body ?? r.title ?? "").trim(),
    line: r.chunkPos,
  };
}

/**
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked result lists
 * into a single ranking without LLM reranking.
 *
 * Formula: score(d) = Σ weight_i / (k + rank_i + 1)
 *
 * @param resultLists - Array of ranked SearchResult arrays (lex, vector, ...)
 * @param weights - Per-list weights (default: 1.0 each)
 * @param k - RRF constant (default: 60, standard value from the original paper)
 */
function reciprocalRankFusion(
  resultLists: SearchResult[][],
  weights: number[] = [],
  k = 60,
): SearchResult[] {
  const merged = new Map<string, { result: SearchResult; rrfScore: number }>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;

    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      if (!result) continue;
      const rrfContribution = weight / (k + rank + 1);
      const existing = merged.get(result.filepath);
      if (existing) {
        existing.rrfScore += rrfContribution;
      } else {
        merged.set(result.filepath, { result, rrfScore: rrfContribution });
      }
    }
  }

  return Array.from(merged.values())
    .map(({ result, rrfScore }) => ({ ...result, score: rrfScore }))
    .sort((a, b) => b.score - a.score);
}

function makeSnippet(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const snippetLines = lines.slice(0, 3);
  if (snippetLines.length === 0) return undefined;
  return snippetLines.join("\n");
}

export class QmdBackend implements MemoryBackend {
  readonly name = "qmd";
  private readonly defaultK: number;
  private dirty = false;
  private flushPending = false;

  constructor(
    private readonly store: QMDStore,
    options: QmdBackendOptions = {}
  ) {
    this.defaultK = options.defaultK ?? 5;
  }

  /**
   * L2 Ambient search — vector-only, no reranking, fast.
   * Maps to `store.searchVector()`.
   */
  async vsearch(query: string, k = this.defaultK): Promise<MemoryHit[]> {
    const results = await this.store.searchVector(query, { limit: k });
    return results.map(searchResultToHit);
  }

  /**
   * L4 Explicit search — BM25 (searchLex) + Vector (searchVector) + RRF.
   *
   * No LLM query expansion, no LLM reranking. Both searches run in parallel,
   * results are fused via Reciprocal Rank Fusion (k=60, equal weights).
   */
  async query(query: string, k = this.defaultK): Promise<MemoryHit[]> {
    const [lexResults, vecResults] = await Promise.all([
      this.store.searchLex(query, { limit: k * 3 }),
      this.store.searchVector(query, { limit: k * 3 }),
    ]);

    const fused = reciprocalRankFusion([lexResults, vecResults]).slice(0, k);
    return fused.map(searchResultToHit);
  }

  /**
   * Generic search entry point. Defaults to vsearch (ambient / fast).
   * Use mode: "explicit" for L4 retrieval (BM25 + vector + RRF, no LLM).
   */
  async search(
    query: string,
    k?: number,
    opts?: { mode?: "ambient" | "explicit" }
  ): Promise<MemoryHit[]> {
    if (opts?.mode === "explicit") {
      return this.query(query, k);
    }
    return this.vsearch(query, k);
  }

  /**
   * L2 Ambient hints — vector-only retrieval for pre-turn injection.
   * Returns typed hints with optional snippet for Top-1 formatting.
   */
  async getAmbientHints(
    query: string,
    opts?: { k?: number; minCosine?: number }
  ): Promise<AmbientHint[]> {
    const k = opts?.k ?? 3;
    const minCosine = opts?.minCosine ?? 0.5;
    const results = await this.store.searchVector(query, { limit: k });
    return results
      .filter((r) => r.score >= minCosine)
      .map((r) => ({
        title: r.title,
        path: r.filepath,
        score: r.score,
        snippet: makeSnippet(r.body),
      }));
  }

  /**
   * Writes a memory entry to disk as a Markdown file, then queues an
   * incremental store update. Rapid successive writes are debounced via
   * a single microtask flush.
   */
  async write(entry: MemoryEntry): Promise<void> {
    const dir = dirname(entry.path);
    await mkdir(dir, { recursive: true });
    await writeFile(entry.path, entry.content, "utf-8");

    this.dirty = true;
    if (!this.flushPending) {
      this.flushPending = true;
      queueMicrotask(() => this.flush());
    }
  }

  private async flush(): Promise<void> {
    this.flushPending = false;
    if (!this.dirty) return;
    this.dirty = false;

    try {
      await this.store.update({ collections: ["memory"] });
      await this.store.embed({ collection: "memory" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[harness] QMD incremental update after write failed: ${message}`);
    }
  }
}
