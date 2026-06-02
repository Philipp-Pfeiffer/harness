import { describe, it, expect, vi } from "vitest";
import { QmdBackend } from "../../src/core/qmdBackend.js";
import type { QMDStore, SearchResult, HybridQueryResult } from "@tobilu/qmd";

function createFakeStore(overrides?: Partial<QMDStore>): QMDStore {
  return {
    internal: {} as any,
    dbPath: "/fake/db.sqlite",
    search: vi.fn(async () => [] as HybridQueryResult[]),
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
    ...overrides,
  } as QMDStore;
}

describe("QmdBackend (SDK)", () => {
  it("name is 'qmd'", () => {
    const backend = new QmdBackend(createFakeStore());
    expect(backend.name).toBe("qmd");
  });

  it("vsearch calls store.searchVector and maps results", async () => {
    const fakeResult: SearchResult = {
      filepath: "/proj/memory/note.md",
      displayPath: "note.md",
      title: "My Note",
      context: null,
      hash: "abc123",
      docid: "abc123",
      collectionName: "memory",
      modifiedAt: new Date().toISOString(),
      bodyLength: 100,
      body: "Hello world",
      score: 0.95,
      source: "vec",
      chunkPos: 42,
    };

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

  it("query calls store.search and maps hybrid results", async () => {
    const fakeResult: HybridQueryResult = {
      file: "/proj/memory/note.md",
      displayPath: "note.md",
      title: "My Note",
      body: "Full body text",
      bestChunk: "Best chunk",
      bestChunkPos: 10,
      score: 0.88,
      context: null,
      docid: "abc123",
    };

    const store = createFakeStore({
      search: vi.fn(async () => [fakeResult]),
    });

    const backend = new QmdBackend(store);
    const hits = await backend.query("hello", 5);

    expect(store.search).toHaveBeenCalledWith({ query: "hello", limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("/proj/memory/note.md");
    expect(hits[0].content).toBe("Best chunk");
    expect(hits[0].line).toBe(10);
  });

  it("search defaults to ambient (vsearch)", async () => {
    const store = createFakeStore();
    const backend = new QmdBackend(store);
    await backend.search("q");

    expect(store.searchVector).toHaveBeenCalledWith("q", { limit: 5 });
  });

  it("search mode explicit calls query", async () => {
    const store = createFakeStore();
    const backend = new QmdBackend(store);
    await backend.search("q", 3, { mode: "explicit" });

    expect(store.search).toHaveBeenCalledWith({ query: "q", limit: 3 });
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
    const fakeResult: SearchResult = {
      filepath: "/proj/memory/title-only.md",
      displayPath: "title-only.md",
      title: "Title Only",
      context: null,
      hash: "abc",
      docid: "abc",
      collectionName: "memory",
      modifiedAt: new Date().toISOString(),
      bodyLength: 0,
      score: 0.7,
      source: "vec",
    };

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
        {
          filepath: "/proj/memory/high.md",
          displayPath: "high.md",
          title: "High",
          context: null,
          hash: "a",
          docid: "a",
          collectionName: "memory",
          modifiedAt: "",
          bodyLength: 10,
          body: "High score",
          score: 0.85,
          source: "vec",
        },
        {
          filepath: "/proj/memory/low.md",
          displayPath: "low.md",
          title: "Low",
          context: null,
          hash: "b",
          docid: "b",
          collectionName: "memory",
          modifiedAt: "",
          bodyLength: 10,
          body: "Low score",
          score: 0.3,
          source: "vec",
        },
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
        {
          filepath: "/proj/memory/weak.md",
          displayPath: "weak.md",
          title: "Weak",
          context: null,
          hash: "a",
          docid: "a",
          collectionName: "memory",
          modifiedAt: "",
          bodyLength: 10,
          body: "Weak",
          score: 0.1,
          source: "vec",
        },
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
        {
          filepath: "/proj/memory/note.md",
          displayPath: "note.md",
          title: "My Note",
          context: null,
          hash: "a",
          docid: "a",
          collectionName: "memory",
          modifiedAt: "",
          bodyLength: 100,
          body: "First line\n\nSecond line\nThird line\nFourth line",
          score: 0.92,
          source: "vec",
        },
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
        {
          filepath: "/proj/memory/empty.md",
          displayPath: "empty.md",
          title: "Empty",
          context: null,
          hash: "a",
          docid: "a",
          collectionName: "memory",
          modifiedAt: "",
          bodyLength: 0,
          score: 0.8,
          source: "vec",
        },
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
