import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import App from "../../src/cli/App.js";
import type { HarnessPaths } from "../../src/config/paths.js";

vi.mock("../../src/tools/registry.js", () => ({
  loadTools: vi.fn(() => []),
  findTool: vi.fn(() => undefined),
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return {
    ...actual,
    getModel: vi.fn((provider: string, modelId: string) => ({ id: `${provider}-${modelId}`, contextWindow: 100000 })),
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

let testBaseDir: string | undefined;

function testPaths(): HarnessPaths {
  testBaseDir = mkdtempSync(join(tmpdir(), "harness-keywarning-test-"));
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

afterEach(() => {
  cleanup();
  mockRun.mockReset();
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

describe("React Key Warning", () => {
  it("does not produce duplicate key warnings with duplicate model entries", async () => {
    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const msg = args.join(" ");
      if (msg.includes("Encountered two children with the same key")) {
        warnings.push(msg);
      }
      originalError.apply(console, args);
    };

    const { stdin } = render(<App paths={testPaths()} />);
    await delay(100); // wait for config load

    stdin.write("/model");
    await delay(50);
    stdin.write("\r");
    await delay(100);
    stdin.write("\r");
    await delay(100);

    console.error = originalError;
    expect(warnings).toHaveLength(0);
  });
});
