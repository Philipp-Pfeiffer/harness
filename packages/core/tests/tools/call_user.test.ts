/**
 * call_user Tool Tests.
 *
 * Verifies:
 * - Number normalization ("+49 151 10619636" → "4915110619636")
 * - Happy path: capability available → ok() with callId
 * - No capability (no voice channel) → err()
 * - No sessionId → err()
 * - Invalid number (no digits) → err()
 * - Empty briefing → err()
 * - Capability failure → err() with the daemon's error message
 */

import { describe, it, expect } from "vitest";
import { callUserTool, normalizeCallNumber } from "../../src/tools/call_user.js";
import type { ToolCallContext } from "../../src/tools/types.js";

function createContext(overrides?: Partial<ToolCallContext>): ToolCallContext {
  return {
    sessionId: "test-session",
    logger: () => {},
    voiceCallStarter: async () => ({ ok: true, callId: "ob-123" }),
    ...overrides,
  };
}

describe("normalizeCallNumber", () => {
  it("strips non-digits", () => {
    expect(normalizeCallNumber("+49 151 10619636")).toBe("4915110619636");
    expect(normalizeCallNumber("+49 (151) 106-19636")).toBe("4915110619636");
    expect(normalizeCallNumber("4915110619636")).toBe("4915110619636");
  });

  it("returns empty string for no digits", () => {
    expect(normalizeCallNumber("abc")).toBe("");
    expect(normalizeCallNumber("")).toBe("");
  });
});

describe("call_user Tool", () => {
  it("normalizes the number and returns ok() with the callId", async () => {
    let captured: { number: string; briefing: string } | undefined;
    const result = await callUserTool.execute(
      { number: "+49 151 10619636", briefing: "Hallo, hier ist Philipp." },
      createContext({
        voiceCallStarter: async (_sid, call) => {
          captured = call;
          return { ok: true, callId: "ob-42" };
        },
      }),
    );
    expect(result.isError).toBe(false);
    expect(captured).toEqual({ number: "4915110619636", briefing: "Hallo, hier ist Philipp." });
    expect(result.content).toContain("ob-42");
  });

  it("returns err() when no voiceCallStarter capability is available", async () => {
    const result = await callUserTool.execute(
      { number: "+49 151 10619636", briefing: "Hallo" },
      createContext({ voiceCallStarter: undefined }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Kein Voice-Channel aktiv");
  });

  it("returns err() when no sessionId is present", async () => {
    const result = await callUserTool.execute(
      { number: "+49 151 10619636", briefing: "Hallo" },
      createContext({ sessionId: undefined }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Keine aktive Session");
  });

  it("returns err() for a number with no digits", async () => {
    const result = await callUserTool.execute(
      { number: "abc", briefing: "Hallo" },
      createContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Ungültige Rufnummer");
  });

  it("returns err() for an empty briefing", async () => {
    const result = await callUserTool.execute(
      { number: "+49 151 10619636", briefing: "   " },
      createContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Briefing darf nicht leer sein");
  });

  it("returns err() with the daemon's error when the starter fails", async () => {
    const result = await callUserTool.execute(
      { number: "+49 151 10619636", briefing: "Hallo" },
      createContext({
        voiceCallStarter: async () => ({
          ok: false,
          error: "Nummer 4915110619636 nicht in voice-registry.json",
        }),
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("nicht in voice-registry.json");
  });
});
