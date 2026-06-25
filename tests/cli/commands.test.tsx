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
    getModel: vi.fn(() => ({ id: "test-model" })),
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
  testBaseDir = mkdtempSync(join(tmpdir(), "harness-commands-test-"));
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

describe("Slash command autocomplete picker", () => {
  it("opens picker when / is typed and shows all commands", async () => {
    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("/");
    await delay(50);

    const frame = lastFrame();
    expect(frame).toContain("/clear");
    expect(frame).toContain("/help");
    expect(frame).toContain("/quit");
  });

  it("filters commands live while typing", async () => {
    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("/cl");
    await delay(50);

    const frame = lastFrame();
    expect(frame).toContain("/clear");
    expect(frame).not.toContain("/help");
    expect(frame).not.toContain("/quit");
  });

  it("closes picker on space and keeps input", async () => {
    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("/cl");
    await delay(50);

    let frame = lastFrame();
    expect(frame).toContain("/clear");

    stdin.write(" ");
    await delay(50);

    frame = lastFrame();
    expect(frame).not.toContain("/clear  –");
    expect(frame).toContain("/cl");
  });

  it("completes command with Enter without auto-executing", async () => {
    const { lastFrame, stdin, frames } = render(<App paths={testPaths()} />);

    stdin.write("/cl");
    await delay(50);
    stdin.write("\r");
    await delay(100);

    // After first Enter, picker should close and input should show /clear
    let frame = lastFrame();
    expect(frame).toContain("/clear");

    // Should NOT have executed yet (no help card rendered)
    const allFrames = frames.join("\n");
    expect(allFrames).not.toContain("Commands");
  });

  it("closes picker on Escape and leaves input as-is", async () => {
    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("/cl");
    await delay(50);

    let frame = lastFrame();
    expect(frame).toContain("/clear");

    stdin.write("\x1b"); // Escape
    await delay(50);

    frame = lastFrame();
    expect(frame).not.toContain("/clear  –");
    expect(frame).toContain("/cl");
  });

  it("navigates with up/down arrows", async () => {
    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("/");
    await delay(50);

    // Default selection is first item (/clear)
    let frame = lastFrame();
    expect(frame).toContain("/clear");

    // Press down three times to reach /quit (clear → help → model → quit)
    stdin.write("\x1b[B");
    await delay(50);
    stdin.write("\x1b[B");
    await delay(50);
    stdin.write("\x1b[B");
    await delay(50);

    // Press Enter to complete /quit
    stdin.write("\r");
    await delay(50);

    frame = lastFrame();
    expect(frame).toContain("/quit");
  });
});
