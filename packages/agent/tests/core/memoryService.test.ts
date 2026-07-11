import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryService } from "../../src/core/memoryService.js";
import type { QMDStore, SearchResult } from "@tobilu/qmd";

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
    ...overrides,
  } as QMDStore;
}

// Monkey-patch createStore to return our fake without loading real native modules
vi.mock("@tobilu/qmd", async () => {
  const actual = await vi.importActual<typeof import("@tobilu/qmd")>("@tobilu/qmd");
  return {
    ...actual,
    createStore: vi.fn(),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import { createStore } from "@tobilu/qmd";
import { readFile, writeFile } from "node:fs/promises";

/** Helper: wait for microtasks + pending promises to flush (multiple rounds for chained awaits) */
async function flushPromises(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("MemoryService", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset();
  });

  afterEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset();
  });

  it("init creates store, registers missing collections; update+embed run in background", async () => {
    const fakeStore = createFakeStore();
    vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

    const service = new MemoryService({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
      dbPath: "/proj/.qmd/index.sqlite",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await service.init();
    logSpy.mockRestore();

    expect(createStore).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPath: "/proj/.qmd/index.sqlite",
      })
    );
    expect(fakeStore.addCollection).toHaveBeenCalledWith("memory", { path: "/proj/memory", pattern: "**/*.md" });
    expect(fakeStore.addCollection).toHaveBeenCalledWith("sources", { path: "/proj/sources", pattern: "**/*.md" });

    // update + embed should NOT have been called yet (they run in background)
    // Wait for background warmup to complete
    await flushPromises();
    expect(fakeStore.update).toHaveBeenCalled();
    expect(fakeStore.embed).toHaveBeenCalled();
    expect(service.degraded).toBe(false);
  });

  it("init skips already existing collections", async () => {
    const fakeStore = createFakeStore({
      listCollections: vi.fn(async () => [
        { name: "memory", pwd: "/proj/memory", glob_pattern: "**/*.md", doc_count: 0, active_count: 0, last_modified: null, includeByDefault: true },
        { name: "sources", pwd: "/proj/sources", glob_pattern: "**/*.md", doc_count: 0, active_count: 0, last_modified: null, includeByDefault: true },
      ]),
    });
    vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

    const service = new MemoryService({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
      dbPath: "/proj/.qmd/index.sqlite",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await service.init();
    logSpy.mockRestore();

    expect(fakeStore.addCollection).not.toHaveBeenCalled();
    expect(service.degraded).toBe(false);
  });

  it("degrades gracefully when createStore fails", async () => {
    vi.mocked(createStore).mockRejectedValueOnce(new Error("sqlite-vec not available"));

    const service = new MemoryService({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
      dbPath: "/proj/.qmd/index.sqlite",
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await service.init();
    warnSpy.mockRestore();

    expect(service.degraded).toBe(true);
    const backend = service.getBackend();
    expect(backend.name).toBe("stub");
    expect(await backend.search("anything")).toEqual([]);
  });

  it("shutdown closes the store after warmup completes", async () => {
    const fakeStore = createFakeStore();
    vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

    const service = new MemoryService({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
      dbPath: "/proj/.qmd/index.sqlite",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await service.init();
    await flushPromises(); // let warmup finish
    logSpy.mockRestore();

    await service.shutdown();
    expect(fakeStore.close).toHaveBeenCalled();
  });

  it("getBackend returns WarmupGatedBackend (name 'qmd-warming') during warmup", async () => {
    const fakeStore = createFakeStore({
      update: vi.fn(async () => new Promise((r) => setTimeout(r, 1000))), // slow warmup
    });
    vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

    const service = new MemoryService({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
      dbPath: "/proj/.qmd/index.sqlite",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await service.init();
    logSpy.mockRestore();

    const backend = service.getBackend();
    expect(backend.name).toBe("qmd-warming");
  });

  it("getBackend returns real QmdBackend after warmup completes", async () => {
    const fakeStore = createFakeStore();
    vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

    const service = new MemoryService({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
      dbPath: "/proj/.qmd/index.sqlite",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await service.init();
    await flushPromises(); // warmup completes
    logSpy.mockRestore();

    const backend = service.getBackend();
    expect(backend.name).toBe("qmd");
  });

  describe("WarmupGatedBackend behavior", () => {
    it("query returns 'index warming' message during warmup", async () => {
      const fakeStore = createFakeStore({
        update: vi.fn(async () => new Promise((r) => setTimeout(r, 5000))), // never completes in test
        searchLex: vi.fn(async () => []),
        searchVector: vi.fn(async () => []),
      });
      vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

      const service = new MemoryService({
        memoryPath: "/proj/memory",
        sourcesPath: "/proj/sources",
        dbPath: "/proj/.qmd/index.sqlite",
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await service.init();
      logSpy.mockRestore();

      const backend = service.getBackend();
      const hits = await backend.query("test", 5);

      expect(hits).toHaveLength(1);
      expect(hits[0].source).toBe("_warmup");
      expect(hits[0].content).toContain("warming up");
    });

    it("getAmbientHints returns [] during warmup (silent, non-blocking)", async () => {
      const fakeStore = createFakeStore({
        update: vi.fn(async () => new Promise((r) => setTimeout(r, 5000))),
        searchVector: vi.fn(async () => [
          { filepath: "/x.md", displayPath: "x.md", title: "X", context: null, hash: "h", docid: "d", collectionName: "memory", modifiedAt: "", bodyLength: 10, body: "content", score: 0.9, source: "vec" },
        ]),
      });
      vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

      const service = new MemoryService({
        memoryPath: "/proj/memory",
        sourcesPath: "/proj/sources",
        dbPath: "/proj/.qmd/index.sqlite",
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await service.init();
      logSpy.mockRestore();

      const backend = service.getBackend();
      const hints = await backend.getAmbientHints("test");

      expect(hints).toEqual([]);
      // searchVector should NOT have been called (gated)
      expect(fakeStore.searchVector).not.toHaveBeenCalled();
    });

    it("query delegates to real backend after warmup completes", async () => {
      const fakeStore = createFakeStore({
        searchLex: vi.fn(async () => [
          { filepath: "/proj/memory/note.md", displayPath: "note.md", title: "Note", context: null, hash: "h", docid: "d", collectionName: "memory", modifiedAt: "", bodyLength: 10, body: "content", score: 0.9, source: "fts" },
        ]),
        searchVector: vi.fn(async () => []),
      });
      vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

      const service = new MemoryService({
        memoryPath: "/proj/memory",
        sourcesPath: "/proj/sources",
        dbPath: "/proj/.qmd/index.sqlite",
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await service.init();
      await flushPromises(); // warmup completes
      logSpy.mockRestore();

      const backend = service.getBackend();
      const hits = await backend.query("test", 5);

      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0].source).toBe("/proj/memory/note.md");
      expect(fakeStore.searchLex).toHaveBeenCalled();
    });

    it("getAmbientHints delegates to real backend after warmup", async () => {
      const fakeStore = createFakeStore({
        searchVector: vi.fn(async () => [
          { filepath: "/x.md", displayPath: "x.md", title: "X", context: null, hash: "h", docid: "d", collectionName: "memory", modifiedAt: "", bodyLength: 10, body: "content", score: 0.9, source: "vec" },
        ]),
      });
      vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

      const service = new MemoryService({
        memoryPath: "/proj/memory",
        sourcesPath: "/proj/sources",
        dbPath: "/proj/.qmd/index.sqlite",
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await service.init();
      await flushPromises(); // warmup completes
      logSpy.mockRestore();

      const backend = service.getBackend();
      const hints = await backend.getAmbientHints("test");

      expect(hints).toHaveLength(1);
      expect(hints[0].title).toBe("X");
    });
  });

  it("calls embed({ force: true }) when configured model differs from marker", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("old-model");

    const fakeStore = createFakeStore();
    vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

    const service = new MemoryService({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
      dbPath: "/proj/.qmd/index.sqlite",
      embedModel: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await service.init();
    await flushPromises(); // wait for warmup
    logSpy.mockRestore();

    expect(fakeStore.embed).toHaveBeenCalledWith({ force: true });
    expect(writeFile).toHaveBeenCalledWith(
      "/proj/.qmd/.embed-model",
      "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      "utf-8"
    );
  });

  it("calls embed({ force: false }) when marker matches configured model", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
    );

    const fakeStore = createFakeStore();
    vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

    const service = new MemoryService({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
      dbPath: "/proj/.qmd/index.sqlite",
      embedModel: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await service.init();
    await flushPromises();
    logSpy.mockRestore();

    expect(fakeStore.embed).toHaveBeenCalledWith({ force: false });
  });

  it("calls embed({ force: false }) on first run when no marker exists", async () => {
    vi.mocked(readFile).mockRejectedValueOnce({ code: "ENOENT" });

    const fakeStore = createFakeStore();
    vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

    const service = new MemoryService({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
      dbPath: "/proj/.qmd/index.sqlite",
      embedModel: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await service.init();
    await flushPromises();
    logSpy.mockRestore();

    expect(fakeStore.embed).toHaveBeenCalledWith({ force: false });
  });

  it("calls embed({ force: false }) when no embedModel is configured", async () => {
    const fakeStore = createFakeStore();
    vi.mocked(createStore).mockResolvedValueOnce(fakeStore);

    const service = new MemoryService({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
      dbPath: "/proj/.qmd/index.sqlite",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await service.init();
    await flushPromises();
    logSpy.mockRestore();

    expect(fakeStore.embed).toHaveBeenCalledWith({ force: false });
  });
});
