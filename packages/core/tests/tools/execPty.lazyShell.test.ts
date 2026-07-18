import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});

describe("execPty lazy shell resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("module import does not throw even when no shell exists", async () => {
    const { existsSync, statSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("no shell");
    });

    const { executeExecPty } = await import("../../src/tools/execPty.ts");
    expect(executeExecPty).toBeDefined();
  });

  it("first call resolves shell and caches it", async () => {
    const { existsSync, statSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({
      isFile: () => true,
      mode: 0o755,
    } as fs.Stats);

    const { executeExecPty } = await import("../../src/tools/execPty.ts");

    const result = await executeExecPty({ command: "echo hello" });
    expect(result.content).toContain("hello");
    expect(result.content).toContain("code: 0");
    expect(existsSync).toHaveBeenCalled();

    vi.mocked(existsSync).mockClear();
    vi.mocked(statSync).mockClear();

    const result2 = await executeExecPty({ command: "echo world" });
    expect(result2.content).toContain("world");
    expect(result2.content).toContain("code: 0");
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("shell resolution failure only affects execPty", async () => {
    const { existsSync, statSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("no shell");
    });

    const { executeExecPty } = await import("../../src/tools/execPty.ts");
    const { executeExecSync } = await import("../../src/tools/exec.ts");
    const { loadTools } = await import("../../src/tools/registry.ts");

    const ptyResult = await executeExecPty({ command: "echo hello" });
    expect(ptyResult.isError).toBe(true);
    expect(ptyResult.content).toContain("Failed to resolve shell");

    const syncResult = await executeExecSync({ command: "echo hello" });
    expect(syncResult.isError).toBe(false);
    expect(syncResult.content).toContain("hello");

    const tools = loadTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.find((t) => t.name === "exec")).toBeDefined();
  });
});
