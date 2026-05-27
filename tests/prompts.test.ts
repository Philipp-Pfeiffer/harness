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

  it("returns empty string for missing variable instead of throwing", () => {
    const result = prompt("steer-annotation", {
      timestamp: "2026-05-25T10:00:00.000Z",
      // userInput is missing
    } as any);
    expect(result).toContain("⚠ Steer während Tool-Call");
    // Missing variable should be replaced with empty string
    expect(result).not.toContain("{{userInput}}");
  });

  it("returns fallback prompt for missing prompt file", () => {
    const result = prompt("does-not-exist", {});
    expect(result).toContain("hilfreicher Assistent");
  });

  it("system-prompt snapshot", () => {
    const result = prompt("system-prompt");
    expect(result).toContain("Terminal-UI");
    expect(result).toContain("Bullet-Listen");
    expect(result).not.toContain("<!--");
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

  it("abort-annotation snapshot", () => {
    const result = prompt("abort-annotation", {
      command: "stopp",
      timestamp: "2026-05-25T11:00:00.000Z",
    });
    expect(result).toMatchInlineSnapshot(`
      "[User-Abort: "stopp" @ 2026-05-25T11:00:00.000Z. Eventuelle vorhergehende Tool-Results sind synthetisch.]
      Nutzer hat Ausführungen abgebrochen.
      "
    `);
  });
});
