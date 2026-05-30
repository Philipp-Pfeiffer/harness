import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QmdBackend } from "../../src/core/qmdBackend.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

function mockExecFile(stdout: string, stderr = "") {
  vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, _opts, callback?) => {
    if (callback) {
      callback(null, stdout, stderr);
    }
    return undefined as any;
  });
}

function mockExecFileError(message: string) {
  vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, _opts, callback?) => {
    if (callback) {
      callback(new Error(message), "", "");
    }
    return undefined as any;
  });
}

describe("QmdBackend", () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFile).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("name is 'qmd'", () => {
    const backend = new QmdBackend();
    expect(backend.name).toBe("qmd");
  });

  it("vsearch calls qmd vsearch with --json", async () => {
    mockExecFile(JSON.stringify([{ file: "a.md", score: 0.9, content: "hello" }]));
    const backend = new QmdBackend();
    const hits = await backend.vsearch("test query", 3);

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "qmd",
      ["vsearch", "test query", "--json", "-n", "3"],
      { timeout: 30000 },
      expect.any(Function)
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("a.md");
    expect(hits[0].content).toBe("hello");
    expect(hits[0].score).toBe(0.9);
  });

  it("query calls qmd query with --json", async () => {
    mockExecFile(JSON.stringify([{ file: "b.md", score: 0.8, chunk: "world" }]));
    const backend = new QmdBackend();
    const hits = await backend.query("test query", 5);

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "qmd",
      ["query", "test query", "--json", "-n", "5"],
      { timeout: 120000 },
      expect.any(Function)
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("b.md");
    expect(hits[0].content).toBe("world");
  });

  it("search defaults to vsearch", async () => {
    mockExecFile(JSON.stringify([]));
    const backend = new QmdBackend();
    await backend.search("fallback");

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "qmd",
      expect.arrayContaining(["vsearch", "fallback"]),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("passes collections when configured", async () => {
    mockExecFile(JSON.stringify([]));
    const backend = new QmdBackend({ collections: ["notes", "docs"] });
    await backend.vsearch("q", 2);

    const args = vi.mocked(childProcess.execFile).mock.calls[0][1] as string[];
    expect(args).toContain("--collection");
    expect(args).toContain("notes");
    expect(args).toContain("docs");
  });

  it("handles qmd binary not found gracefully", async () => {
    mockExecFileError("spawn qmd ENOENT");
    const backend = new QmdBackend();
    await expect(backend.vsearch("q")).rejects.toThrow("spawn qmd ENOENT");
  });

  it("parses nested results object", async () => {
    mockExecFile(JSON.stringify({ results: [{ file: "c.md", score: 0.7, content: "nested" }] }));
    const backend = new QmdBackend();
    const hits = await backend.vsearch("q");
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("c.md");
  });

  it("returns empty array for unparseable json", async () => {
    mockExecFile("not json");
    const backend = new QmdBackend();
    const hits = await backend.vsearch("q");
    expect(hits).toEqual([]);
  });

  it("filters out results with no content", async () => {
    mockExecFile(JSON.stringify([{ file: "d.md", score: 0.5 }]));
    const backend = new QmdBackend();
    const hits = await backend.vsearch("q");
    expect(hits).toEqual([]);
  });

  it("write creates file and directories", async () => {
    const backend = new QmdBackend();
    const dir = `/tmp/qmd-test-write-${Date.now()}`;
    const path = `${dir}/note.md`;
    await backend.write({ path, content: "# Note\n\nHello" });

    const { readFile, rm } = await import("node:fs/promises");
    const content = await readFile(path, "utf-8");
    expect(content).toBe("# Note\n\nHello");
    await rm(dir, { recursive: true });
  });
});
