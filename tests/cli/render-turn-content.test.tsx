import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import { Box } from "ink";
import { renderTurnContent } from "../../src/cli/App.js";

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

vi.mock("../../src/core/agent.js", () => ({
  createAgent: vi.fn(() => ({
    run: vi.fn(),
    setModel: vi.fn(),
  })),
}));

afterEach(() => {
  cleanup();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("renderTurnContent key warnings", () => {
  it("does not produce duplicate key warnings with multiple tools", async () => {
    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const msg = args.join(" ");
      if (msg.includes("Encountered two children with the same key")) {
        warnings.push(msg);
      }
      originalError.apply(console, args);
    };

    const tools = [
      { id: "tool-1", name: "readFile", status: "done" as const, preview: "file content" },
      { id: "tool-2", name: "exec", status: "done" as const, preview: "output" },
      { id: "tool-3", name: "readFile", status: "pending" as const, preview: "loading" },
    ];

    const elements = renderTurnContent(
      "First text\nSecond text\nThird text",
      tools,
      [11, 23, 35],
      false
    );

    render(<Box flexDirection="column">{elements}</Box>);
    await delay(50);

    console.error = originalError;
    expect(warnings).toHaveLength(0);
  });

  it("does not produce duplicate key warnings when no tools are present", async () => {
    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const msg = args.join(" ");
      if (msg.includes("Encountered two children with the same key")) {
        warnings.push(msg);
      }
      originalError.apply(console, args);
    };

    const elements = renderTurnContent("Just some text", [], [], false);

    render(<Box flexDirection="column">{elements}</Box>);
    await delay(50);

    console.error = originalError;
    expect(warnings).toHaveLength(0);
  });
});
