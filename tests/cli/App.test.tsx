import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "ink-testing-library";
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

describe("CLI App", () => {
  it("renders initial prompt", () => {
    const { lastFrame } = render(<App />);
    expect(lastFrame()).toContain("Du:");
  });

  it("streams agent tokens after user input", async () => {
    mockRun.mockImplementation(async (_messages, options) => {
      options?.onEvent?.({ type: "token", text: "Hello" });
      options?.onEvent?.({ type: "token", text: " world!" });
      return { aborted: false, turns: 1, finalMessage: "Hello world!" };
    });

    const { lastFrame, stdin } = render(<App />);

    stdin.write("hi");
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write("\r");

    await new Promise((resolve) => setTimeout(resolve, 200));

    const frame = lastFrame();
    expect(frame).toContain("Du: hi");
    expect(mockRun).toHaveBeenCalled();
    expect(frame).toContain("Hello world!");
  });
});
