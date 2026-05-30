import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureQmdCollections } from "../../src/core/qmdSetup.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

function mockExecFile(responses: Array<{ stdout?: string; stderr?: string; error?: Error | null }>) {
  let callIndex = 0;
  vi.mocked(childProcess.execFile).mockImplementation((_cmd, _args, _opts, callback?) => {
    const resp = responses[callIndex++] ?? { stdout: "", stderr: "", error: null };
    if (callback) {
      callback(resp.error ?? null, resp.stdout ?? "", resp.stderr ?? "");
    }
    return undefined as any;
  });
}

describe("ensureQmdCollections", () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFile).mockReset();
  });

  it("registers collections and runs update + embed when qmd is available", async () => {
    mockExecFile([
      { stdout: "1.2.3" }, // --version
      { stdout: "", stderr: "" }, // collection add memory
      { stdout: "", stderr: "" }, // collection add sources
      { stdout: "updated" }, // update
      { stdout: "embedded" }, // embed
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await ensureQmdCollections({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
    });

    const calls = vi.mocked(childProcess.execFile).mock.calls;
    expect(calls[0][1]).toEqual(["--version"]);
    expect(calls[1][1]).toEqual(["collection", "add", "/proj/memory", "--name", "memory", "--mask", "**/*.md"]);
    expect(calls[2][1]).toEqual(["collection", "add", "/proj/sources", "--name", "sources", "--mask", "**/*.md"]);
    expect(calls[3][1]).toEqual(["update"]);
    expect(calls[4][1]).toEqual(["embed"]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("qmd collections ready"));
    logSpy.mockRestore();
  });

  it("skips gracefully when qmd is not installed", async () => {
    mockExecFile([{ error: new Error("spawn qmd ENOENT") }]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensureQmdCollections({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("QMD not found"));
    warnSpy.mockRestore();
  });

  it("treats 'already exists' as idempotent skip", async () => {
    mockExecFile([
      { stdout: "1.2.3" },
      { stdout: "", stderr: "Collection 'memory' already exists" },
      { stdout: "", stderr: "Collection 'sources' already exists" },
      { stdout: "updated" },
      { stdout: "embedded" },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await ensureQmdCollections({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already present: memory, sources"));
    logSpy.mockRestore();
  });

  it("logs warning if collection add fails with unexpected error", async () => {
    mockExecFile([
      { stdout: "1.2.3" },
      { error: new Error("Permission denied") },
      { stdout: "", stderr: "Collection 'sources' already exists" },
      { stdout: "updated" },
      { stdout: "embedded" },
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensureQmdCollections({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to register QMD collection"));
    warnSpy.mockRestore();
  });

  it("logs warning if update/embed fails but continues", async () => {
    mockExecFile([
      { stdout: "1.2.3" },
      { stdout: "" },
      { stdout: "" },
      { error: new Error("update crash") },
      { error: new Error("embed crash") },
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensureQmdCollections({
      memoryPath: "/proj/memory",
      sourcesPath: "/proj/sources",
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("qmd update failed"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("qmd embed failed"));
    warnSpy.mockRestore();
  });
});
