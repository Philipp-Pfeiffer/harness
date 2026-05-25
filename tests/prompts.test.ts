import { describe, it, expect } from "vitest";
import { prompt } from "../src/prompts.js";

describe("prompt()", () => {
  it("loads an existing prompt and substitutes variables", () => {
    const result = prompt("steer-annotation", {
      userInput: "test input",
      timestamp: "2026-05-25T10:00:00.000Z",
    });
    expect(result).toContain("⚠ Steer während Tool-Call");
    expect(result).toContain("test input");
    expect(result).not.toContain("<!--");
  });

  it("throws on missing variable", () => {
    expect(() =>
      prompt("steer-annotation", {
        timestamp: "2026-05-25T10:00:00.000Z",
        // userInput is missing
      } as any)
    ).toThrow('prompt(steer-annotation): missing variable "userInput"');
  });

  it("throws on missing prompt file", () => {
    expect(() => prompt("does-not-exist", {})).toThrow();
  });

  it("steer-annotation snapshot", () => {
    const result = prompt("steer-annotation", {
      userInput: "Apfelsaft",
      timestamp: "2026-05-25T10:00:00.000Z",
    });
    expect(result).toMatchInlineSnapshot(`
      "⚠ Steer während Tool-Call. Behandle als Korrektur/Ergänzung der ursprünglichen Aufgabe:
      Apfelsaft
      "
    `);
  });
});
