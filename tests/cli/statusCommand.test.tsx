import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import App from "../../src/cli/App.js";
import { isStatusCommand, handleStatusCommand } from "../../src/cli/statusCommand.js";
import type { HarnessPaths } from "../../src/config/paths.js";

vi.mock("../../src/tools/registry.js", () => ({
  loadTools: vi.fn(() => []),
  findTool: vi.fn(() => undefined),
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return {
    ...actual,
    getModel: vi.fn(() => ({ id: "test-model", contextWindow: 100000 })),
  };
});

const mockRun = vi.fn();

vi.mock("../../src/core/agent.js", () => ({
  createAgent: vi.fn(() => ({
    run: mockRun,
    setModel: vi.fn(),
    setSystemPrompt: vi.fn(),
  })),
}));

const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

let testBaseDir: string | undefined;

function testPaths(): HarnessPaths {
  testBaseDir = mkdtempSync(join(tmpdir(), "harness-status-test-"));
  return {
    home: join(testBaseDir, "home"),
    state: join(testBaseDir, "state"),
    core: join(testBaseDir, "home", "core.md"),
    agents: join(testBaseDir, "home", "AGENTS.md"),
    config: join(testBaseDir, "home", "config.json"),
    memory: join(testBaseDir, "home", "memory"),
    inbox: join(testBaseDir, "home", "memory", "_inbox.md"),
    sources: join(testBaseDir, "home", "sources"),
    skills: join(testBaseDir, "home", "skills"),
    sessions: join(testBaseDir, "state", "sessions"),
    metrics: join(testBaseDir, "state", "metrics"),
    index: join(testBaseDir, "state", "index"),
  };
}

beforeEach(() => {
  exitSpy.mockClear();
  vi.spyOn(process, "cwd").mockReturnValue("/tmp");
  mockRun.mockReset();
});

afterEach(() => {
  cleanup();
  if (testBaseDir) {
    try {
      rmdirSync(testBaseDir, { recursive: true });
    } catch {
      // ignore cleanup failures
    }
    testBaseDir = undefined;
  }
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("isStatusCommand", () => {
  it("recognizes exact /status", () => {
    expect(isStatusCommand("/status")).toBe(true);
  });

  it("recognizes /status with trailing whitespace", () => {
    expect(isStatusCommand("/status ")).toBe(true);
    expect(isStatusCommand("  /status  ")).toBe(true);
  });

  it("recognizes /status with extra args", () => {
    expect(isStatusCommand("/status --json")).toBe(true);
  });

  it("does not match /statusfoo", () => {
    expect(isStatusCommand("/statusfoo")).toBe(false);
  });

  it("does not match non-slash input", () => {
    expect(isStatusCommand("status")).toBe(false);
    expect(isStatusCommand("hello world")).toBe(false);
  });

  it("does not match other slash commands", () => {
    expect(isStatusCommand("/help")).toBe(false);
    expect(isStatusCommand("/clear")).toBe(false);
  });
});

describe("handleStatusCommand", () => {
  it("returns formatted status without LLM calls", async () => {
    const output = await handleStatusCommand("/status", {
      model: "minimax-m2.7",
      workspace: "/home/user/dev/harness",
      sessionState: "ready",
      memoryReady: true,
      toolCalls: 5,
      errors: 0,
    });
    expect(output).toContain("Harness Status");
    expect(output).toContain("minimax-m2.7");
    expect(output).toContain("/home/user/dev/harness");
    expect(output).toContain("ready");
  });

  it("degrades to n/a when metrics and session usage are missing", async () => {
    const output = await handleStatusCommand("/status", {
      sessionState: "ready",
      toolCalls: 0,
      errors: 0,
    });
    expect(output).toContain("n/a");
    expect(output).toContain("Harness Status");
  });
});

describe("/status in TUI", () => {
  it("renders status output in the chat area without calling agent", async () => {
    const { stdin, frames } = render(<App paths={testPaths()} />);

    stdin.write("/status");
    await delay(50);
    stdin.write("\r");
    await delay(100);
    // Picker may consume first Enter to complete command, press again to submit
    stdin.write("\r");
    await delay(200);

    const allFrames = frames.join("\n");
    expect(allFrames).toContain("Harness Status");
    expect(allFrames).toContain("Workspace");
    // Agent must NOT have been called
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("shows /status in autocomplete picker", async () => {
    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("/");
    await delay(50);

    const frame = lastFrame();
    expect(frame).toContain("/status");
  });
});
