import { describe, it, expect, vi, afterEach } from "vitest";
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
});
