import { describe, it, expect, vi, beforeAll } from "vitest";
import { marked } from "marked";

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

describe("markdown rendering", () => {
  beforeAll(async () => {
    // Side-effect: import App.tsx to trigger marked-terminal configuration
    await import("../../src/cli/App.js");
  });
  it("renders a flat list", () => {
    expect(marked.parse("- item 1\n- item 2\n- item 3")).toMatchSnapshot();
  });

  it("renders a nested list", () => {
    expect(marked.parse("- item 1\n  - nested a\n  - nested b\n- item 2")).toMatchSnapshot();
  });

  it("renders headings", () => {
    expect(marked.parse("# Heading 1\n## Heading 2\n### Heading 3")).toMatchSnapshot();
  });

  it("renders a code block", () => {
    expect(marked.parse("```ts\nconst x = 1;\n```")).toMatchSnapshot();
  });

  it("renders inline code", () => {
    expect(marked.parse("Use the `renderMarkdown` helper.")).toMatchSnapshot();
  });

  it("renders a mixed document", () => {
    const input = [
      "## Summary",
      "",
      "- First point",
      "  - Sub-point A",
      "  - Sub-point B",
      "- Second point",
      "",
      "Run `npm test` to verify:",
      "",
      "```ts",
      "expect(true).toBe(true);",
      "```",
      "",
      "**Bold** and *italic* text.",
    ].join("\n");
    expect(marked.parse(input)).toMatchSnapshot();
  });
});
