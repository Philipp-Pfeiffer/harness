import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ToolCard } from "../../src/cli/App.js";

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
    setSystemPrompt: vi.fn(),
  })),
}));

describe("ToolCard", () => {
  it("renders short expanded content", () => {
    const { lastFrame } = render(
      <ToolCard
        item={{ id: "1", name: "write", status: "done", preview: "short preview", expanded: true, result: "short result" }}
        isLast={true}
      />
    );
    expect(lastFrame()).toMatchInlineSnapshot(`
      "
      ┌─ ✓ write ── Ctrl+O ─ ──────────────────────────────────────────────────────┐
      │ short result
      └────────────────────────────────────────────────────────────────────────────┘
      "
    `);
  });

  it("renders long expanded content", () => {
    const result = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join("\n");
    const { lastFrame } = render(
      <ToolCard
        item={{ id: "2", name: "readFile", status: "done", preview: "", expanded: true, result }}
        isLast={false}
      />
    );
    expect(lastFrame()).toMatchInlineSnapshot(`
      "
      ┌─ ✓ readFile ───────────────────────────────────────────────────────────────┐
      │ Line 1
      │ Line 2
      │ Line 3
      │ Line 4
      │ Line 5
      │ Line 6
      │ Line 7
      │ Line 8
      │ Line 9
      │ Line 10
      └────────────────────────────────────────────────────────────────────────────┘
      "
    `);
  });

  it("renders very wide single-line content with wrapped indent", () => {
    const result = "a".repeat(200);
    const { lastFrame } = render(
      <ToolCard
        item={{ id: "3", name: "exec", status: "done", preview: "", expanded: true, result }}
        isLast={false}
      />
    );
    expect(lastFrame()).toMatchInlineSnapshot(`
      "
      ┌─ ✓ exec ───────────────────────────────────────────────────────────────────┐
      │ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      │ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      │ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      └────────────────────────────────────────────────────────────────────────────┘
      "
    `);
  });
});
