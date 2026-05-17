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
    getModel: vi.fn((provider: string, modelId: string) => ({ id: `${provider}-${modelId}`, contextWindow: 100000 })),
  };
});

const mockRun = vi.fn();

vi.mock("../../src/core/agent.js", () => ({
  createAgent: vi.fn(() => ({
    run: mockRun,
    setModel: vi.fn(),
  })),
}));

afterEach(() => {
  cleanup();
  mockRun.mockReset();
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

    const { stdin } = render(<App />);
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
