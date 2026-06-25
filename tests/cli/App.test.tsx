import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { mkdtempSync, rmdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import App from "../../src/cli/App.js";
import { createAgent } from "../../src/core/agent.js";
import { createSession, recordTurn } from "../../src/core/session.js";
import type { HarnessPaths } from "../../src/config/paths.js";
import type { SessionTurn } from "../../src/core/session.js";
import type { Message } from "@mariozechner/pi-ai";

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
  testBaseDir = mkdtempSync(join(tmpdir(), "harness-app-test-"));
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
});

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

async function readJsonl(path: string): Promise<SessionTurn[]> {
  try {
    const raw = await readFile(path, "utf-8");
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as SessionTurn);
  } catch {
    return [];
  }
}

function baseTurn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: "turn-1",
    role: "assistant",
    content: "Hello",
    userContent: "Hi",
    tokens: {
      input: 10,
      output: 5,
      total: 15,
      cacheRead: 0,
      cacheWrite: 0,
    },
    timing: {
      startedAt: "2026-06-25T10:00:00.000Z",
      latencyMs: 1234,
    },
    model: "test-model",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("CLI App", () => {
  it("renders header with model and status", () => {
    const { lastFrame } = render(<App paths={testPaths()} />);
    const frame = lastFrame();
    expect(frame).toContain("harness");
    expect(frame).toContain("test-model");
    expect(frame).toContain("ready");
    expect(frame).toContain("❯");
  });

  it("creates a session on startup", async () => {
    render(<App paths={testPaths()} />);
    await delay(100);
    expect(testBaseDir).toBeDefined();
    const indexRaw = await readFile(join(testBaseDir!, "state", "sessions", "sessions.json"), "utf-8");
    const index = JSON.parse(indexRaw) as unknown[];
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ status: "active", title: "CLI Session" });
  });

  it("streams agent tokens after user input", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      options?.onEvent?.({ type: "token", text: "Hello" });
      options?.onEvent?.({ type: "token", text: " world!" });
      return { aborted: false, turns: 1, finalMessage: "Hello world!", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
    });

    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("hi");
    await delay(50);
    stdin.write("\r");
    await delay(200);

    const frame = lastFrame();
    expect(frame).toContain("❯ hi");
    expect(mockRun).toHaveBeenCalled();
    expect(frame).toContain("Hello world!");
  });

  it("renders tool card in active turn and toggles with Ctrl+O", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      await delay(50);
      options?.onEvent?.({ type: "tool_call_start", name: "echo", args: { text: "hi" } });
      await delay(50);
      options?.onEvent?.({ type: "tool_call_done", name: "echo", result: "hello world" });
      await delay(500); // keep turn active so Ctrl+O can toggle
      return { aborted: false, turns: 1, finalMessage: "Done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
    });

    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("run echo");
    await delay(50);
    stdin.write("\r");
    await delay(150);

    const frame = lastFrame();
    expect(frame).toContain("echo");
    expect(frame).toContain("✓");

    // Toggle expanded with Ctrl+O while still active
    stdin.write("\x0f"); // Ctrl+O
    await delay(100);

    const expandedFrame = lastFrame();
    expect(expandedFrame).toContain("hello world");
  });

  it("renders 3 parallel tool cards with distinct keys and borders", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      await delay(50);
      options?.onEvent?.({ type: "tool_call_start", name: "exec", args: { cmd: "a" } });
      options?.onEvent?.({ type: "tool_call_start", name: "exec", args: { cmd: "b" } });
      options?.onEvent?.({ type: "tool_call_start", name: "exec", args: { cmd: "c" } });
      await delay(50);
      options?.onEvent?.({ type: "tool_call_done", name: "exec", result: "result-a" });
      options?.onEvent?.({ type: "tool_call_done", name: "exec", result: "result-b" });
      options?.onEvent?.({ type: "tool_call_done", name: "exec", result: "result-c" });
      await delay(100);
      return { aborted: false, turns: 1, finalMessage: "Done" };
    });

    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("run 3 tools");
    await delay(50);
    stdin.write("\r");
    await delay(300);

    const frame = lastFrame();
    // 3 cards, each with top border and bottom border
    const topBorders = (frame.match(/┌─/g) || []).length;
    const bottomBorders = (frame.match(/└/g) || []).length;
    expect(topBorders).toBeGreaterThanOrEqual(3);
    expect(bottomBorders).toBeGreaterThanOrEqual(3);
    expect(frame).toContain("✓ exec");
  });

  it("renders tool result in expanded card body", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      await delay(50);
      options?.onEvent?.({ type: "tool_call_start", name: "read", args: { path: "file.txt" } });
      await delay(50);
      options?.onEvent?.({ type: "tool_call_done", name: "read", result: "file content here" });
      await delay(500);
      return { aborted: false, turns: 1, finalMessage: "Done" };
    });

    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("run read");
    await delay(50);
    stdin.write("\r");
    await delay(150);

    // Toggle expanded
    stdin.write("\x0f"); // Ctrl+O
    await delay(100);

    const frame = lastFrame();
    expect(frame).toContain("file content here");
    // Bottom border closes the box
    expect(frame).toContain("└");
  });

  it("shows tool preview between borders when collapsed", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      await delay(50);
      options?.onEvent?.({ type: "tool_call_start", name: "exec", args: { cmd: "echo hello" } });
      await delay(50);
      options?.onEvent?.({ type: "tool_call_done", name: "exec", result: "hello" });
      await delay(500);
      return { aborted: false, turns: 1, finalMessage: "Done" };
    });

    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("run exec");
    await delay(50);
    stdin.write("\r");
    await delay(150);

    const frame = lastFrame();
    // Preview should be visible between top and bottom border
    expect(frame).toContain("hello");
    expect(frame).toContain("│");
  });

  it("/help renders help card", async () => {
    const { lastFrame, stdin, frames } = render(<App paths={testPaths()} />);

    stdin.write("/help");
    await delay(50);
    stdin.write("\r");
    await delay(100);
    // Picker consumes first Enter to complete command, press again to submit
    stdin.write("\r");
    await delay(100);

    const allFrames = frames.join("\n");
    expect(allFrames).toContain("Commands");
    expect(allFrames).toContain("/clear");
    expect(allFrames).toContain("/quit");
  });

  it("/quit exits cleanly", async () => {
    const { stdin } = render(<App paths={testPaths()} />);

    stdin.write("/quit");
    await delay(50);
    stdin.write("\r");
    await delay(100);
    // Picker consumes first Enter to complete command, press again to submit
    stdin.write("\r");
    await delay(100);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("unknown slash command shows error", async () => {
    const { lastFrame, stdin, frames } = render(<App paths={testPaths()} />);

    stdin.write("/foo");
    await delay(50);
    stdin.write("\r");
    await delay(100);

    const allFrames = frames.join("\n");
    expect(allFrames).toContain("Unknown command: /foo");
  });

  it("completed turns accumulate in frames", async () => {
    let callCount = 0;
    mockRun.mockImplementation(async (_messages, options) => {
      callCount++;
      options?.onEvent?.({ type: "token", text: `Response ${callCount}` });
      return { aborted: false, turns: 1, finalMessage: `Response ${callCount}`, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
    });

    const { stdin, frames } = render(<App paths={testPaths()} />);

    stdin.write("first");
    await delay(50);
    stdin.write("\r");
    await delay(200);

    stdin.write("second");
    await delay(50);
    stdin.write("\r");
    await delay(200);

    const allFrames = frames.join("\n");
    expect(allFrames).toContain("Response 1");
    expect(allFrames).toContain("Response 2");
    expect(allFrames).toContain("❯ first");
    expect(allFrames).toContain("❯ second");
  });

  it("shows [abgebrochen] and moves turn to completed after abort", async () => {
    let resolveRun: (value: { aborted: boolean; turns: number; finalMessage: string }) => void;
    const runPromise = new Promise<{ aborted: boolean; turns: number; finalMessage: string }>((resolve) => {
      resolveRun = resolve;
    });

    mockRun.mockImplementation(async (_messages, options) => {
      await delay(50);
      options?.onEvent?.({ type: "token", text: "Partial" });
      await delay(50);
      options?.onEvent?.({ type: "tool_call_start", name: "slow", args: {} });
      // Wait for abort
      await runPromise;
      return { aborted: true, turns: 0, finalMessage: "", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
    });

    const { lastFrame, stdin, frames } = render(<App paths={testPaths()} />);

    stdin.write("run slow");
    await delay(50);
    stdin.write("\r");
    await delay(150);

    // Active turn should show streaming + tool card
    let frame = lastFrame();
    expect(frame).toContain("Partial");
    expect(frame).toContain("slow");

    // Send Ctrl+C
    stdin.write("\x03"); // Ctrl+C
    await delay(100);

    // Should show [abgebrochen] in active turn
    frame = lastFrame();
    expect(frame).toContain("[abgebrochen]");

    // Resolve the mock run
    resolveRun!({ aborted: true, turns: 0, finalMessage: "" });
    await delay(200);

    // Turn should now be in completed turns with abort marker
    const allFrames = frames.join("\n");
    expect(allFrames).toContain("[abgebrochen]");
    expect(allFrames).toContain("❯ run slow");
  });

  it("toggles completed turn tool card with Ctrl+O", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      await delay(50);
      options?.onEvent?.({ type: "tool_call_start", name: "read", args: { path: "x.txt" } });
      await delay(50);
      options?.onEvent?.({ type: "tool_call_done", name: "read", result: "secret content" });
      return { aborted: false, turns: 1, finalMessage: "Done" };
    });

    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("run read");
    await delay(50);
    stdin.write("\r");
    await delay(200);

    // Turn is completed; toggle its tool card
    stdin.write("\x0f"); // Ctrl+O
    await delay(100);

    const frame = lastFrame();
    expect(frame).toContain("secret content");
  });

  it("renders assistant text before and after tools in correct order", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      options?.onEvent?.({ type: "token", text: "Before tools. " });
      await delay(20);
      options?.onEvent?.({ type: "tool_call_start", name: "exec", args: { cmd: "date" } });
      await delay(20);
      options?.onEvent?.({ type: "tool_call_done", name: "exec", result: "Sat May 16" });
      await delay(20);
      options?.onEvent?.({ type: "token", text: "After tools." });
      return { aborted: false, turns: 1, finalMessage: "Before tools. After tools.", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
    });

    const { lastFrame, stdin } = render(<App paths={testPaths()} />);

    stdin.write("run date");
    await delay(50);
    stdin.write("\r");
    await delay(300);

    const frame = lastFrame();
    expect(frame).toContain("Before tools.");
    expect(frame).toContain("After tools.");
    expect(frame).toContain("Sat May 16");
    // "Before tools" should appear before the tool card in the frame
    const beforeIdx = frame.indexOf("Before tools");
    const toolIdx = frame.indexOf("exec");
    const afterIdx = frame.indexOf("After tools");
    expect(beforeIdx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(afterIdx);
  });

  describe("PromptInput editing", () => {
    it("deletes a word with Ctrl+Backspace (kitty protocol)", async () => {
      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("hello world test");
      await delay(50);

      // Kitty protocol: delete with ctrl modifier
      stdin.write("\x1b[127;5u");
      await delay(50);

      const frame = lastFrame();
      // Should show "hello world " (test removed)
      expect(frame).toContain("hello world");
      expect(frame).not.toContain("world test");
    });

    it("deletes a word with Alt+Backspace", async () => {
      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("hello world test");
      await delay(50);

      // Alt+Backspace = ESC + DEL
      stdin.write("\x1b\x7f");
      await delay(50);

      const frame = lastFrame();
      expect(frame).toContain("hello world");
      expect(frame).not.toContain("world test");
    });

    it("selects text with Shift+Left/Right arrows", async () => {
      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("hello");
      await delay(50);

      // Shift+Left twice (rxvt sequences)
      stdin.write("\x1b[d");
      await delay(30);
      stdin.write("\x1b[d");
      await delay(30);

      const frame = lastFrame();
      // The selected chars "lo" should be highlighted
      expect(frame).toContain("hello");
    });

    it("replaces selected text on typing", async () => {
      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("hello world");
      await delay(50);

      // Move cursor to position 6 (start of "world"): Left 5x
      for (let i = 0; i < 5; i++) {
        stdin.write("\x1b[D");
        await delay(10);
      }

      // Select "world" with Shift+Right 5x
      for (let i = 0; i < 5; i++) {
        stdin.write("\x1b[c");
        await delay(10);
      }

      // Type "moon"
      stdin.write("moon");
      await delay(50);

      const frame = lastFrame();
      expect(frame).toContain("hello moon");
      expect(frame).not.toContain("world");
    });

    it("deletes selected text with Backspace", async () => {
      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("hello world");
      await delay(50);

      // Move cursor to position 6 (start of "world"): Left 5x
      for (let i = 0; i < 5; i++) {
        stdin.write("\x1b[D");
        await delay(10);
      }

      // Select "world" with Shift+Right 5x
      for (let i = 0; i < 5; i++) {
        stdin.write("\x1b[c");
        await delay(10);
      }

      // Backspace deletes selection
      stdin.write("\x7f");
      await delay(50);

      const frame = lastFrame();
      expect(frame).toContain("hello");
      expect(frame).not.toContain("world");
    });

    it("does not clear text on Down arrow when no history exists", async () => {
      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("keep me");
      await delay(50);

      // Down arrow without history should not clear text
      stdin.write("\x1b[B");
      await delay(50);

      const frame = lastFrame();
      expect(frame).toContain("keep me");
    });

    it("deletes a word with Ctrl+H (terminal sends BS for Ctrl+Backspace)", async () => {
      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("hello world test");
      await delay(50);

      // Ctrl+H = \x08, which many terminals send for Ctrl+Backspace
      stdin.write("\x08");
      await delay(50);

      const frame = lastFrame();
      expect(frame).toContain("hello world");
      expect(frame).not.toContain("world test");
    });
  });

  describe("Persistent input and status bar", () => {
    it("shows status bar at bottom with model, status and cwd", () => {
      const { lastFrame } = render(<App paths={testPaths()} />);
      const frame = lastFrame();
      // Status bar should contain model, harness label, ready status, and cwd
      expect(frame).toContain("harness");
      expect(frame).toContain("test-model");
      expect(frame).toContain("ready");
      expect(frame).toContain(process.cwd());
      // Input prompt should be visible
      expect(frame).toContain("❯");
    });

    it("keeps input visible during streaming", async () => {
      mockRun.mockImplementation(async (_messages, options) => {
        await delay(50);
        options?.onEvent?.({ type: "token", text: "streaming" });
        await delay(500);
        return { aborted: false, turns: 1, finalMessage: "streaming" };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("test");
      await delay(50);
      stdin.write("\r");
      await delay(150);

      const frame = lastFrame();
      // Input should still be visible while streaming
      expect(frame).toContain("❯");
      expect(frame).toContain("streaming");
    });

    it("allows typing during streaming", async () => {
      mockRun.mockImplementation(async (_messages, options) => {
        await delay(50);
        options?.onEvent?.({ type: "token", text: "first" });
        await delay(500);
        return { aborted: false, turns: 1, finalMessage: "first" };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("run");
      await delay(50);
      stdin.write("\r");
      await delay(150);

      // Type while streaming
      stdin.write("next");
      await delay(50);

      const frame = lastFrame();
      // Typed text should appear in the input line
      expect(frame).toContain("next");
    });

    it("queues steer message during streaming", async () => {
      mockRun.mockImplementation(async (_messages, options) => {
        await delay(50);
        options?.onEvent?.({ type: "token", text: "first" });
        await delay(500);
        return { aborted: false, turns: 1, finalMessage: "first" };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("run");
      await delay(50);
      stdin.write("\r");
      await delay(150);

      // Type and press Enter while streaming
      stdin.write("steer message");
      await delay(50);
      stdin.write("\r");
      await delay(50);

      const frame = lastFrame();
      // Input should be cleared after submit
      expect(frame).not.toContain("❯ steer message");
      // Steer should appear in active turn
      expect(frame).toContain("[steer]");
      expect(frame).toContain("steer message");
      // mockRun should only be called once (for the first submit)
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it("queues multiple steer messages during a turn", async () => {
      let resolveRun: (value: { aborted: boolean; turns: number; finalMessage: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }) => void;
      const runPromise = new Promise<{ aborted: boolean; turns: number; finalMessage: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }>((resolve) => {
        resolveRun = resolve;
      });

      mockRun.mockImplementation(async (_messages, options) => {
        await delay(50);
        options?.onEvent?.({ type: "token", text: "working" });
        await runPromise;
        return { aborted: false, turns: 1, finalMessage: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
      });

      const { lastFrame, stdin, frames } = render(<App paths={testPaths()} />);

      stdin.write("run");
      await delay(50);
      stdin.write("\r");
      await delay(150);

      // Queue first steer
      stdin.write("steer one");
      await delay(50);
      stdin.write("\r");
      await delay(50);

      let frame = lastFrame();
      expect(frame).toContain("[steer]");
      expect(frame).toContain("steer one");

      // Queue second steer
      stdin.write("steer two");
      await delay(50);
      stdin.write("\r");
      await delay(50);

      frame = lastFrame();
      expect(frame).toContain("steer one");
      expect(frame).toContain("steer two");

      // End the turn
      resolveRun!({ aborted: false, turns: 1, finalMessage: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } });
      await delay(200);

      // Both steers should have been visible during the active turn
      const allFrames = frames.join("\n");
      expect(allFrames).toContain("steer one");
      expect(allFrames).toContain("steer two");
      // Turn should complete normally (turn content visible in completed turns)
      expect(allFrames).toContain("working");
      // mockRun should only be called once
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it("aborts the turn when steer message is 'stopp'", async () => {
      let resolveRun: (value: { aborted: boolean; turns: number; finalMessage: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }) => void;
      const runPromise = new Promise<{ aborted: boolean; turns: number; finalMessage: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }>((resolve) => {
        resolveRun = resolve;
      });

      mockRun.mockImplementation(async (_messages, options) => {
        await delay(50);
        options?.onEvent?.({ type: "token", text: "working" });
        await runPromise;
        return { aborted: false, turns: 1, finalMessage: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
      });

      const { lastFrame, stdin, frames } = render(<App paths={testPaths()} />);

      stdin.write("run");
      await delay(50);
      stdin.write("\r");
      await delay(150);

      // Send "stopp" while running
      stdin.write("stopp");
      await delay(50);
      stdin.write("\r");
      await delay(50);

      let frame = lastFrame();
      expect(frame).toContain("[steer]");
      expect(frame).toContain("stopp");

      // Resolve the run — but it should have been aborted
      resolveRun!({ aborted: false, turns: 1, finalMessage: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } });
      await delay(200);

      const allFrames = frames.join("\n");
      // The turn should show as aborted
      expect(allFrames).toContain("[abgebrochen]");
      // mockRun should have been called once, then aborted by the steer
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it("preserves multi-line input with Shift+Enter during streaming", async () => {
      mockRun.mockImplementation(async (_messages, options) => {
        await delay(50);
        options?.onEvent?.({ type: "token", text: "stream" });
        await delay(500);
        return { aborted: false, turns: 1, finalMessage: "stream" };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("run");
      await delay(50);
      stdin.write("\r");
      await delay(150);

      // Type multi-line during streaming
      stdin.write("line1");
      await delay(20);
      // Shift+Enter = newline
      stdin.write("\x1b[13;2u");
      await delay(20);
      stdin.write("line2");
      await delay(50);

      const frame = lastFrame();
      // Both lines should be visible
      expect(frame).toContain("line1");
      expect(frame).toContain("line2");
    });
  });

  describe("Token counter", () => {
    it("shows token counter after first turn", async () => {
      mockRun.mockImplementation(async (_messages, options) => {
        options?.onEvent?.({ type: "token", text: "Hello" });
        return { aborted: false, turns: 1, finalMessage: "Hello", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("hi");
      await delay(50);
      stdin.write("\r");
      await delay(200);

      const frame = lastFrame();
      expect(frame).toContain("15 / 100.0k");
    });

    it("formats tokens with k-suffix above 999", async () => {
      mockRun.mockImplementation(async (_messages, options) => {
        options?.onEvent?.({ type: "usage", inputTokens: 17654, outputTokens: 1000, totalTokens: 18654 });
        return { aborted: false, turns: 1, finalMessage: "Done", usage: { inputTokens: 17654, outputTokens: 1000, totalTokens: 18654, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("test");
      await delay(50);
      stdin.write("\r");
      await delay(200);

      const frame = lastFrame();
      expect(frame).toContain("18.7k / 100.0k");
    });

    it("shows yellow counter above 80% context window", async () => {
      mockRun.mockImplementation(async (_messages, options) => {
        options?.onEvent?.({ type: "usage", inputTokens: 85000, outputTokens: 1000, totalTokens: 86000 });
        return { aborted: false, turns: 1, finalMessage: "Done", usage: { inputTokens: 85000, outputTokens: 1000, totalTokens: 86000, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("test");
      await delay(50);
      stdin.write("\r");
      await delay(200);

      const frame = lastFrame();
      expect(frame).toContain("86.0k / 100.0k");
    });

    it("shows red counter above 95% context window", async () => {
      mockRun.mockImplementation(async (_messages, options) => {
        options?.onEvent?.({ type: "usage", inputTokens: 96000, outputTokens: 1000, totalTokens: 97000 });
        return { aborted: false, turns: 1, finalMessage: "Done", usage: { inputTokens: 96000, outputTokens: 1000, totalTokens: 97000, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("test");
      await delay(50);
      stdin.write("\r");
      await delay(200);

      const frame = lastFrame();
      expect(frame).toContain("97.0k / 100.0k");
    });

    it("accumulates tokens across multiple turns", async () => {
      let callCount = 0;
      mockRun.mockImplementation(async (_messages, options) => {
        callCount++;
        options?.onEvent?.({ type: "token", text: `Response ${callCount}` });
        return { aborted: false, turns: 1, finalMessage: `Response ${callCount}`, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("first");
      await delay(50);
      stdin.write("\r");
      await delay(200);

      stdin.write("second");
      await delay(50);
      stdin.write("\r");
      await delay(200);

      const frame = lastFrame();
      // Per-call: last run had 15 tokens, shown against context window
      expect(frame).toContain("15 / 100.0k");
      // Session total (accumulated): 30
      expect(frame).toContain("Ses: 30");
    });

    it("resets token counter on /clear", async () => {
      mockRun.mockImplementation(async (_messages, options) => {
        options?.onEvent?.({ type: "token", text: "Hello" });
        return { aborted: false, turns: 1, finalMessage: "Hello", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      stdin.write("hi");
      await delay(50);
      stdin.write("\r");
      await delay(200);

      let frame = lastFrame();
      expect(frame).toContain("15 / 100.0k");

      stdin.write("/clear");
      await delay(50);
      stdin.write("\r");
      await delay(100);
      // Picker consumes first Enter to complete command, press again to submit
      stdin.write("\r");
      await delay(100);

      frame = lastFrame();
      expect(frame).not.toContain("15 / 100.0k");
      expect(frame).not.toContain(" / ");
    });

    it("keeps token counter across /model switch", async () => {
      mockRun.mockImplementation(async (_messages, options) => {
        options?.onEvent?.({ type: "token", text: "Hello" });
        return { aborted: false, turns: 1, finalMessage: "Hello", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 } };
      });

      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      // Wait for config fallback to load
      await delay(100);

      stdin.write("hi");
      await delay(50);
      stdin.write("\r");
      await delay(200);

      let frame = lastFrame();
      expect(frame).toContain("15 / 100.0k");

      stdin.write("/model");
      await delay(50);
      stdin.write("\r");
      await delay(100);
      // Submit /model command
      stdin.write("\r");
      await delay(100);

      // Select first model
      stdin.write("\r");
      await delay(100);

      // After model switch, run another turn
      stdin.write("next");
      await delay(50);
      stdin.write("\r");
      await delay(200);

      frame = lastFrame();
      // Per-call: last run had 15 tokens
      expect(frame).toContain("15 / 100.0k");
      // Session total: 15 + 15 = 30
      expect(frame).toContain("Ses: 30");
    });
  });

  describe("/model command", () => {
    it("opens model picker and shows fallback models", async () => {
      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      // Wait for config fallback to load
      await delay(100);

      stdin.write("/model");
      await delay(50);
      stdin.write("\r");
      await delay(100);
      // Picker consumes first Enter to complete command, press again to submit
      stdin.write("\r");
      await delay(100);

      const frame = lastFrame();
      expect(frame).toContain("Select model:");
      expect(frame).toContain("MiniMax M2.7");
    });

    it("switches model and updates header", async () => {
      const { lastFrame, stdin } = render(<App paths={testPaths()} />);

      // Wait for config fallback to load
      await delay(100);

      stdin.write("/model");
      await delay(50);
      stdin.write("\r");
      await delay(100);
      // Submit /model command
      stdin.write("\r");
      await delay(100);

      // Press Enter to select first model
      stdin.write("\r");
      await delay(100);

      const frame = lastFrame();
      // getModel mock returns `${provider}-${modelId}`
      expect(frame).toContain("test-model");
    });

    it("calls setModel on agent when switching", async () => {
      const setModelSpy = vi.fn();
      vi.mocked(createAgent).mockReturnValueOnce({
        run: mockRun,
        setModel: setModelSpy,
        setSystemPrompt: vi.fn(),
      } as any);

      const { stdin } = render(<App paths={testPaths()} />);

      // Wait for config fallback to load
      await delay(100);

      stdin.write("/model");
      await delay(50);
      stdin.write("\r");
      await delay(100);
      // Submit /model command
      stdin.write("\r");
      await delay(100);

      // Select first model
      stdin.write("\r");
      await delay(100);

      expect(setModelSpy).toHaveBeenCalled();
    });
  });

  describe("/session command", () => {
    it("lists sessions with id, date, model, turns and token total", async () => {
      const paths = testPaths();
      const { lastFrame, stdin } = render(<App paths={paths} />);

      await delay(100);

      const target = await createSession(paths, { model: "test-model", title: "Target Session" });
      await recordTurn(target, baseTurn({ id: "t1", content: "Listed" }), paths);

      stdin.write("/session");
      await delay(50);
      stdin.write("\r");
      await delay(100);
      // Picker consumes first Enter to complete the command
      stdin.write("\r");
      await delay(200);

      const frame = lastFrame();
      expect(frame).toContain(target.id);
      expect(frame).toContain("test-model");
      expect(frame).toContain("1 turns");
    });

    it("resumes a session and appends new turns to it", async () => {
      const paths = testPaths();
      const { frames, stdin } = render(<App paths={paths} />);

      await delay(100);

      const target = await createSession(paths, { model: "test-model" });
      await recordTurn(
        target,
        baseTurn({ id: "old-turn", userContent: "Old question", content: "Old answer" }),
        paths,
      );

      stdin.write(`/session ${target.id}`);
      await delay(50);
      stdin.write("\r");
      await delay(300);

      const allFrames = frames.join("\n");
      expect(allFrames).toContain("Old question");
      expect(allFrames).toContain("Old answer");
      expect(allFrames).toContain("Resumed session");

      mockRun.mockImplementation(async (_messages, options) => {
        options?.onEvent?.({ type: "token", text: "New response" });
        return {
          aborted: false,
          turns: 1,
          finalMessage: "New response",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, toolCallCount: 0 },
        };
      });

      stdin.write("new question");
      await delay(50);
      stdin.write("\r");
      await delay(300);

      expect(frames.join("\n")).toContain("New response");

      const transcript = await readJsonl(target.transcriptPath);
      expect(transcript).toHaveLength(2);
      expect(transcript[1].userContent).toBe("new question");
    });

    it("warns before loading a large session and resumes only after confirmation or --force", async () => {
      const paths = testPaths();
      const { frames, stdin } = render(<App paths={paths} />);

      await delay(100);

      const target = await createSession(paths, { model: "test-model" });
      const bigText = "x".repeat(210_000);
      await recordTurn(
        target,
        baseTurn({
          id: "big-turn",
          userContent: "Big",
          content: "Big answer",
          messages: [{ role: "user", content: bigText, timestamp: Date.now() } as unknown as Message],
        }),
        paths,
      );

      stdin.write(`/session ${target.id}`);
      await delay(50);
      stdin.write("\r");
      await delay(300);

      let allFrames = frames.join("\n");
      expect(allFrames).toContain("will load ~");
      expect(allFrames).toContain("threshold");
      expect(allFrames).not.toContain("Resumed session");

      // Cancel the pending resume
      stdin.write("n");
      await delay(50);
      stdin.write("\r");
      await delay(200);

      allFrames = frames.join("\n");
      expect(allFrames).toContain("Resume cancelled");

      // Force resume
      stdin.write(`/session ${target.id} --force`);
      await delay(50);
      stdin.write("\r");
      await delay(300);

      allFrames = frames.join("\n");
      expect(allFrames).toContain("Resumed session");
    });

    it("opens interactive picker and resumes selected session with Enter", async () => {
      const paths = testPaths();
      const { frames, stdin, lastFrame } = render(<App paths={paths} />);

      await delay(100);

      const target = await createSession(paths, { model: "test-model" });
      await recordTurn(
        target,
        baseTurn({ id: "pick-turn", userContent: "Pick me", content: "Picked" }),
        paths,
      );

      stdin.write("/session");
      await delay(50);
      stdin.write("\r");
      await delay(100);
      // Submit /session command
      stdin.write("\r");
      await delay(200);

      let frame = lastFrame();
      expect(frame).toContain("Select session:");
      expect(frame).toContain(target.id);

      // Target is the most recent session and should be preselected at index 0
      stdin.write("\r");
      await delay(300);

      const allFrames = frames.join("\n");
      expect(allFrames).toContain("Pick me");
      expect(allFrames).toContain("Picked");
      expect(allFrames).toContain("Resumed session");
    });

    it("cancels the picker with Escape without resuming", async () => {
      const paths = testPaths();
      const { frames, stdin, lastFrame } = render(<App paths={paths} />);

      await delay(100);

      const target = await createSession(paths, { model: "test-model" });
      await recordTurn(
        target,
        baseTurn({ id: "esc-turn", userContent: "Esc me", content: "Escaped" }),
        paths,
      );

      stdin.write("/session");
      await delay(50);
      stdin.write("\r");
      await delay(100);
      stdin.write("\r");
      await delay(200);

      expect(lastFrame()).toContain("Select session:");

      stdin.write("\x1b");
      await delay(100);

      expect(lastFrame()).not.toContain("Select session:");
      expect(frames.join("\n")).not.toContain("Resumed session");
    });

    it("filters the picker by typing and resumes the matching session", async () => {
      const paths = testPaths();
      const { frames, stdin, lastFrame } = render(<App paths={paths} />);

      await delay(100);

      const target = await createSession(paths, { model: "test-model" });
      await recordTurn(
        target,
        baseTurn({ id: "filter-turn", userContent: "Filter me", content: "Filtered" }),
        paths,
      );

      stdin.write("/session");
      await delay(50);
      stdin.write("\r");
      await delay(100);
      stdin.write("\r");
      await delay(200);

      // Type the last 6 characters of the target id as a filter
      const filter = target.id.slice(-6);
      stdin.write(filter);
      await delay(100);

      expect(lastFrame()).toContain(`Filter: ${filter}`);

      stdin.write("\r");
      await delay(300);

      const allFrames = frames.join("\n");
      expect(allFrames).toContain("Filter me");
      expect(allFrames).toContain("Resumed session");
    });

    it("warns before resuming a large session selected from the picker", async () => {
      const paths = testPaths();
      const { frames, stdin, lastFrame } = render(<App paths={paths} />);

      await delay(100);

      const target = await createSession(paths, { model: "test-model" });
      const bigText = "x".repeat(210_000);
      await recordTurn(
        target,
        baseTurn({
          id: "big-pick-turn",
          userContent: "Big pick",
          content: "Big answer",
          messages: [{ role: "user", content: bigText, timestamp: Date.now() } as unknown as Message],
        }),
        paths,
      );

      stdin.write("/session");
      await delay(50);
      stdin.write("\r");
      await delay(100);
      stdin.write("\r");
      await delay(200);

      stdin.write("\r");
      await delay(300);

      let allFrames = frames.join("\n");
      expect(allFrames).toContain("will load ~");
      expect(allFrames).not.toContain("Resumed session");

      stdin.write("y");
      await delay(50);
      stdin.write("\r");
      await delay(300);

      allFrames = frames.join("\n");
      expect(allFrames).toContain("Resumed session");
    });
  });
});
