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

  it("renders tool card after tool call", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      options?.onEvent?.({ type: "tool_call_start", name: "echo", args: { text: "hi" } });
      options?.onEvent?.({ type: "tool_call_done", name: "echo", result: "hello world" });
      return { aborted: false, turns: 1, finalMessage: "Done" };
    });

    const { lastFrame, stdin } = render(<App />);

    stdin.write("run echo");
    await delay(50);
    stdin.write("\r");
    await delay(200);

    const frame = lastFrame();
    expect(frame).toContain("echo");
    expect(frame).toContain("✓");

    // Toggle expanded with Ctrl+O
    stdin.write("\x0f"); // Ctrl+O
    await delay(50);

    const expandedFrame = lastFrame();
    expect(expandedFrame).toContain("hello world");
  });

  it("clears history on /clear", async () => {
    mockRun.mockImplementation(async () => ({ aborted: false, turns: 1, finalMessage: "Hi" }));

    const { lastFrame, stdin } = render(<App />);

    stdin.write("hello");
    await delay(50);
    stdin.write("\r");
    await delay(200);

    expect(lastFrame()).toContain("Hi");

    stdin.write("/clear");
    await delay(50);
    stdin.write("\r");
    await delay(100);

    const frame = lastFrame();
    expect(frame).not.toContain("Hi");
    expect(frame).not.toContain("hello");
    expect(frame).toContain("harness");
    expect(frame).toContain("ready");
  });
});
