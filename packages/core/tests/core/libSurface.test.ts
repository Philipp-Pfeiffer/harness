import { describe, it, expect } from "vitest";
import {
  createAgent,
  prompt,
  resolveModelFromConfig,
  readFileTool,
} from "../../src/lib.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixturePromptDir = join(__dirname, "..", "fixtures", "prompts");

describe("library surface", () => {
  it("exports createAgent as a function", () => {
    expect(typeof createAgent).toBe("function");
  });

  it("exports prompt as a function", () => {
    expect(typeof prompt).toBe("function");
  });

  it("exports resolveModelFromConfig as a function", () => {
    expect(typeof resolveModelFromConfig).toBe("function");
  });

  it("exports at least one concrete tool", () => {
    expect(typeof readFileTool).toBe("object");
    expect(readFileTool.name).toBe("readFile");
    expect(typeof readFileTool.execute).toBe("function");
  });

  it("prompt() loads from a custom dir when opts.dir is provided", () => {
    const result = prompt("test-prompt", { source: "fixture" }, { dir: fixturePromptDir });
    expect(result).toContain("Custom prompt from fixture.");
    expect(result).not.toContain("{{source}}");
  });

  it("prompt() still falls back to built-in prompts without opts.dir", () => {
    const result = prompt("system-prompt");
    expect(result).toContain("Harness");
  });
});
