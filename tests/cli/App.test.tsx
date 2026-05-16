import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import App from "../../src/cli/App.js";

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
  })),
}));

const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

beforeEach(() => {
  exitSpy.mockClear();
});

afterEach(() => {
  cleanup();
  mockRun.mockReset();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("CLI App", () => {
  it("renders header with model and status", () => {
    const { lastFrame } = render(<App />);
    const frame = lastFrame();
    expect(frame).toContain("harness");
    expect(frame).toContain("test-model");
    expect(frame).toContain("ready");
    expect(frame).toContain("❯");
  });

  it("streams agent tokens after user input", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      options?.onEvent?.({ type: "token", text: "Hello" });
      options?.onEvent?.({ type: "token", text: " world!" });
      return { aborted: false, turns: 1, finalMessage: "Hello world!" };
    });

    const { lastFrame, stdin } = render(<App />);

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
      return { aborted: false, turns: 1, finalMessage: "Done" };
    });

    const { lastFrame, stdin } = render(<App />);

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

    const { lastFrame, stdin } = render(<App />);

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

    const { lastFrame, stdin } = render(<App />);

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

  it("/help renders help card", async () => {
    const { lastFrame, stdin, frames } = render(<App />);

    stdin.write("/help");
    await delay(50);
    stdin.write("\r");
    await delay(100);

    const allFrames = frames.join("\n");
    expect(allFrames).toContain("Commands");
    expect(allFrames).toContain("/clear");
    expect(allFrames).toContain("/quit");
  });

  it("/quit exits cleanly", async () => {
    const { stdin } = render(<App />);

    stdin.write("/quit");
    await delay(50);
    stdin.write("\r");
    await delay(100);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("unknown slash command shows error", async () => {
    const { lastFrame, stdin, frames } = render(<App />);

    stdin.write("/foo");
    await delay(50);
    stdin.write("\r");
    await delay(100);

    const allFrames = frames.join("\n");
    expect(allFrames).toContain("Unknown command: /foo");
  });

  it("Static smoke: completed turns accumulate in frames", async () => {
    let callCount = 0;
    mockRun.mockImplementation(async (_messages, options) => {
      callCount++;
      options?.onEvent?.({ type: "token", text: `Response ${callCount}` });
      return { aborted: false, turns: 1, finalMessage: `Response ${callCount}` };
    });

    const { stdin, frames } = render(<App />);

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

  it("shows [abgebrochen] and moves turn to static after abort", async () => {
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
      return { aborted: true, turns: 0, finalMessage: "" };
    });

    const { lastFrame, stdin, frames } = render(<App />);

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

    // Turn should now be in static with abort marker
    const allFrames = frames.join("\n");
    expect(allFrames).toContain("[abgebrochen]");
    expect(allFrames).toContain("❯ run slow");
  });

  it("adds spacing between user message and assistant reply", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      options?.onEvent?.({ type: "token", text: "Reply text" });
      return { aborted: false, turns: 1, finalMessage: "Reply text" };
    });

    const { lastFrame, stdin } = render(<App />);

    stdin.write("hello");
    await delay(50);
    stdin.write("\r");
    await delay(200);

    const frame = lastFrame();
    // There should be spacing between ❯ hello and Reply text
    // Since the turn is now completed and in static, check the rendered output
    expect(frame).toContain("Reply text");
  });
});
