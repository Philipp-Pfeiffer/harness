import { describe, it, expect, vi } from "vitest";
import { MemoryService } from "../../src/core/memoryService.js";
import type { QMDStore } from "@tobilu/qmd";

function createFakeStore(overrides?: Partial<QMDStore>): QMDStore {
  return {
    internal: {} as any,
    dbPath: "/fake/db.sqlite",
    search: vi.fn(async () => []),
    searchLex: vi.fn(async () => []),
    searchVector: vi.fn(async () => []),
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

import { createStore } from "@tobilu/qmd";

describe("MemoryService", () => {
  it("init creates store, registers missing collections, runs update+embed", async () => {
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

  it("shutdown closes the store", async () => {
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

    await service.shutdown();
    expect(fakeStore.close).toHaveBeenCalled();
  });

  it("getBackend returns QmdBackend when healthy", async () => {
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

    const backend = service.getBackend();
    expect(backend.name).toBe("qmd");
  });
});
