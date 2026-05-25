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

  it("abort-annotation snapshot", () => {
    const result = prompt("abort-annotation", {
      command: "stopp",
      timestamp: "2026-05-25T11:00:00.000Z",
    });
    expect(result).toMatchInlineSnapshot(`
      "Der vorherige Turn wurde durch ein User-Abort-Kommando beendet (Kommando: "stopp", Zeitpunkt: 2026-05-25T11:00:00.000Z).
      Die zuletzt begonnene Aufgabe ist NICHT abgeschlossen. Eventuelle Tool-Calls wurden mit einem synthetischen Abort-Result versehen, das Resultat ist nicht real.
      Warte auf den nächsten User-Input. Wenn der User eine neue Richtung vorgibt, übernimm sie. Wenn er nichts Inhaltliches schickt, frag knapp nach, wie weiterverfahren werden soll. Nimm die abgebrochene Aufgabe nicht stillschweigend wieder auf.
      "
    `);
  });
});
