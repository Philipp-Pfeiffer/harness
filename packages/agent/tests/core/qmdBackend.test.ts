import { describe, it, expect, vi } from "vitest";
import { QmdBackend } from "../../src/core/qmdBackend.js";
import type { QMDStore, SearchResult } from "@tobilu/qmd";

function makeSearchResult(
  filepath: string,
  title: string,
  score: number,
  body?: string,
  chunkPos?: number,
): SearchResult {
  return {
    filepath,
    displayPath: filepath.split("/").pop() ?? filepath,
    title,
    context: null,
    hash: "hash_" + filepath,
    docid: "doc_" + filepath,
    collectionName: "memory",
    modifiedAt: new Date().toISOString(),
    bodyLength: body?.length ?? 0,
    body,
    score,
    source: "vec",
    chunkPos,
  };
}

function createFakeStore(overrides?: Partial<QMDStore>): QMDStore {
  return {
    internal: {} as any,
    dbPath: "/fake/db.sqlite",
    search: vi.fn(async () => []),
    searchLex: vi.fn(async () => []),
    searchVector: vi.fn(async () => [] as SearchResult[]),
    expandQuery: vi.fn(async () => []),
    get: vi.fn(async () => ({ error: "not_found", query: "", similarFiles: [] } as any)),
    getDocumentBody: vi.fn(async () => null),
    multiGet: vi.fn(async () => ({ docs: [], errors: [] })),
    addCollection: vi.fn(async () => {}),
    removeCollection: vi.fn(async () => true),
    renameCollection: vi.fn(async () => true),
    listCollections: vi.fn(async () => []),
    getDefaultCollectionNames: vi.fn(async () => []),
    addContext: vi.fn(async () => true),
    removeContext: vi.fn(async () => true),
    setGlobalContext: vi.fn(async () => {}),
    getGlobalContext: vi.fn(async () => undefined),
    listContexts: vi.fn(async () => []),
    update: vi.fn(async () => ({ collections: 0, indexed: 0, updated: 0, unchanged: 0, removed: 0, needsEmbedding: 0 })),
    embed: vi.fn(async () => ({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 })),
    getStatus: vi.fn(async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false, collections: [] })),
    getIndexHealth: vi.fn(async () => ({ needsEmbedding: 0, totalDocs: 0, daysStale: null })),
    close: vi.fn(async () => {}),
    rerank: vi.fn(async () => ({ results: [] })),
    ...overrides,
  } as QMDStore;
}

describe("QmdBackend (SDK)", () => {
  it("name is 'qmd'", () => {
    const backend = new QmdBackend(createFakeStore());
    expect(backend.name).toBe("qmd");
  });

  it("vsearch calls store.searchVector and maps results", async () => {
    const fakeResult = makeSearchResult("/proj/memory/note.md", "My Note", 0.95, "Hello world", 42);

    const store = createFakeStore({
      searchVector: vi.fn(async () => [fakeResult]),
    });

    const backend = new QmdBackend(store);
    const hits = await backend.vsearch("hello", 3);

    expect(store.searchVector).toHaveBeenCalledWith("hello", { limit: 3 });
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("/proj/memory/note.md");
    expect(hits[0].score).toBe(0.95);
    expect(hits[0].content).toBe("Hello world");
    expect(hits[0].line).toBe(42);
  });

  describe("query (L4 explicit — BM25 + vector + RRF, no LLM)", () => {
    it("calls searchLex and searchVector in parallel, not store.search", async () => {
      const lexResult = makeSearchResult("/proj/memory/lex.md", "Lex Hit", 0.8, "Lex body");
      const vecResult = makeSearchResult("/proj/memory/vec.md", "Vec Hit", 0.9, "Vec body");

      const store = createFakeStore({
        searchLex: vi.fn(async () => [lexResult]),
        searchVector: vi.fn(async () => [vecResult]),
      });

      const backend = new QmdBackend(store);
      const hits = await backend.query("hello", 5);

      // Must call searchLex and searchVector
      expect(store.searchLex).toHaveBeenCalledWith("hello", { limit: 15 });
      expect(store.searchVector).toHaveBeenCalledWith("hello", { limit: 15 });

      // Must NOT call store.search (the LLM expansion + rerank path)
      expect(store.search).not.toHaveBeenCalled();

      // Must NOT call expandQuery (LLM query expansion)
      expect(store.expandQuery).not.toHaveBeenCalled();

      // Both results appear in fused output
      expect(hits).toHaveLength(2);
      const sources = hits.map((h) => h.source);
      expect(sources).toContain("/proj/memory/lex.md");
      expect(sources).toContain("/proj/memory/vec.md");
    });

    it("RRF fuses overlapping results — same file in both lists merges to one hit", async () => {
      const shared = makeSearchResult("/proj/memory/shared.md", "Shared", 0.9, "Shared body");
      const lexOnly = makeSearchResult("/proj/memory/lex-only.md", "Lex Only", 0.7, "Lex body");
      const vecOnly = makeSearchResult("/proj/memory/vec-only.md", "Vec Only", 0.8, "Vec body");

      const store = createFakeStore({
        searchLex: vi.fn(async () => [shared, lexOnly]),
        searchVector: vi.fn(async () => [shared, vecOnly]),
      });

      const backend = new QmdBackend(store);
      const hits = await backend.query("test", 10);

      // 3 unique files, not 4 (shared appears once)
      expect(hits).toHaveLength(3);
      const sources = hits.map((h) => h.source);
      expect(sources).toContain("/proj/memory/shared.md");
      expect(sources).toContain("/proj/memory/lex-only.md");
      expect(sources).toContain("/proj/memory/vec-only.md");

      // Shared file should have higher RRF score than single-list hits
      const sharedHit = hits.find((h) => h.source === "/proj/memory/shared.md");
      const lexOnlyHit = hits.find((h) => h.source === "/proj/memory/lex-only.md");
      expect(sharedHit!.score).toBeGreaterThan(lexOnlyHit!.score);
    });

    it("respects k limit on fused results", async () => {
      const results = Array.from({ length: 10 }, (_, i) =>
        makeSearchResult(`/proj/memory/note-${i}.md`, `Note ${i}`, 0.9 - i * 0.05),
      );

      const store = createFakeStore({
        searchLex: vi.fn(async () => results.slice(0, 5)),
        searchVector: vi.fn(async () => results.slice(5)),
      });

      const backend = new QmdBackend(store);
      const hits = await backend.query("test", 3);

      expect(hits).toHaveLength(3);
    });

    it("returns empty array when both lists are empty", async () => {
      const store = createFakeStore();
      const backend = new QmdBackend(store);
      const hits = await backend.query("nothing", 5);

      expect(hits).toEqual([]);
      expect(store.search).not.toHaveBeenCalled();
    });

    it("works when searchLex returns empty but searchVector has results", async () => {
      const vecResult = makeSearchResult("/proj/memory/vec.md", "Vec Hit", 0.85, "Vec body");

      const store = createFakeStore({
        searchLex: vi.fn(async () => []),
        searchVector: vi.fn(async () => [vecResult]),
      });

      const backend = new QmdBackend(store);
      const hits = await backend.query("hello", 5);

      expect(hits).toHaveLength(1);
      expect(hits[0].source).toBe("/proj/memory/vec.md");
    });
  });

  it("search defaults to ambient (vsearch)", async () => {
    const store = createFakeStore();
    const backend = new QmdBackend(store);
    await backend.search("q");

    expect(store.searchVector).toHaveBeenCalledWith("q", { limit: 5 });
  });

  it("search mode explicit calls query (searchLex + searchVector), not store.search", async () => {
    const store = createFakeStore();
    const backend = new QmdBackend(store);
    await backend.search("q", 3, { mode: "explicit" });

    expect(store.searchLex).toHaveBeenCalledWith("q", { limit: 9 });
    expect(store.searchVector).toHaveBeenCalledWith("q", { limit: 9 });
    expect(store.search).not.toHaveBeenCalled();
  });

  it("regression: query path never calls store.rerank (no LLM reranker)", async () => {
    const store = createFakeStore({
      searchLex: vi.fn(async () => [makeSearchResult("/p/a.md", "A", 0.8, "body")]),
      searchVector: vi.fn(async () => [makeSearchResult("/p/b.md", "B", 0.9, "body")]),
    });

    const backend = new QmdBackend(store);
    await backend.query("test", 5);

    // Reranker must never be invoked — query uses RRF only
    expect(store.rerank).not.toHaveBeenCalled();
    expect(store.expandQuery).not.toHaveBeenCalled();
    expect(store.search).not.toHaveBeenCalled();
  });

  it("regression: vsearch path never calls store.rerank or store.search", async () => {
    const store = createFakeStore({
      searchVector: vi.fn(async () => [makeSearchResult("/p/a.md", "A", 0.9, "body")]),
    });

    const backend = new QmdBackend(store);
    await backend.vsearch("test", 5);

    expect(store.rerank).not.toHaveBeenCalled();
    expect(store.expandQuery).not.toHaveBeenCalled();
    expect(store.search).not.toHaveBeenCalled();
  });

  it("write creates file and queues incremental update", async () => {
    const store = createFakeStore();
    const backend = new QmdBackend(store);
    const dir = `/tmp/qmd-sdk-write-${Date.now()}`;
    const path = `${dir}/note.md`;

    await backend.write({ path, content: "# Note\n\nHello" });

    const { readFile, rm } = await import("node:fs/promises");
    const content = await readFile(path, "utf-8");
    expect(content).toBe("# Note\n\nHello");

    // Flush is queued as microtask; give it a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(store.update).toHaveBeenCalledWith({ collections: ["memory"] });
    expect(store.embed).toHaveBeenCalledWith({ collection: "memory" });

    await rm(dir, { recursive: true });
  });

  it("maps SearchResult without body to title fallback", async () => {
    const fakeResult = makeSearchResult("/proj/memory/title-only.md", "Title Only", 0.7);

    const store = createFakeStore({
      searchVector: vi.fn(async () => [fakeResult]),
    });

    const backend = new QmdBackend(store);
    const hits = await backend.vsearch("test");
    expect(hits[0].content).toBe("Title Only");
  });

  describe("getAmbientHints", () => {
    it("calls store.searchVector with limit from opts", async () => {
      const store = createFakeStore();
      const backend = new QmdBackend(store);
      await backend.getAmbientHints("hello", { k: 5 });

      expect(store.searchVector).toHaveBeenCalledWith("hello", { limit: 5 });
    });

    it("filters out scores below minCosine", async () => {
      const results: SearchResult[] = [
        makeSearchResult("/proj/memory/high.md", "High", 0.85, "High score"),
        makeSearchResult("/proj/memory/low.md", "Low", 0.3, "Low score"),
      ];

      const store = createFakeStore({
        searchVector: vi.fn(async () => results),
      });

      const backend = new QmdBackend(store);
      const hints = await backend.getAmbientHints("hello", { minCosine: 0.5 });

      expect(hints).toHaveLength(1);
      expect(hints[0].title).toBe("High");
      expect(hints[0].score).toBe(0.85);
    });

    it("returns empty array when all scores below threshold", async () => {
      const results: SearchResult[] = [
        makeSearchResult("/proj/memory/weak.md", "Weak", 0.1, "Weak"),
      ];

      const store = createFakeStore({
        searchVector: vi.fn(async () => results),
      });

      const backend = new QmdBackend(store);
      const hints = await backend.getAmbientHints("hello");

      expect(hints).toEqual([]);
    });

    it("maps title, path, score, and snippet correctly", async () => {
      const results: SearchResult[] = [
        makeSearchResult(
          "/proj/memory/note.md",
          "My Note",
          0.92,
          "First line\n\nSecond line\nThird line\nFourth line",
        ),
      ];

      const store = createFakeStore({
        searchVector: vi.fn(async () => results),
      });

      const backend = new QmdBackend(store);
      const hints = await backend.getAmbientHints("hello");

      expect(hints).toHaveLength(1);
      expect(hints[0].title).toBe("My Note");
      expect(hints[0].path).toBe("/proj/memory/note.md");
      expect(hints[0].score).toBe(0.92);
      expect(hints[0].snippet).toBe("First line\nSecond line\nThird line");
    });

    it("omits snippet when body is empty", async () => {
      const results: SearchResult[] = [
        makeSearchResult("/proj/memory/empty.md", "Empty", 0.8),
      ];

      const store = createFakeStore({
        searchVector: vi.fn(async () => results),
      });

      const backend = new QmdBackend(store);
      const hints = await backend.getAmbientHints("hello");

      expect(hints[0].snippet).toBeUndefined();
    });

    it("uses default k=3 and minCosine=0.5 when opts omitted", async () => {
      const store = createFakeStore();
      const backend = new QmdBackend(store);
      await backend.getAmbientHints("hello");

      expect(store.searchVector).toHaveBeenCalledWith("hello", { limit: 3 });
    });
  });
});
