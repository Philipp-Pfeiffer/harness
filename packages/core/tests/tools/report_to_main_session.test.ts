/**
 * report_to_main_session Tool Tests.
 *
 * Verifies:
 * - Happy path: capability available → ok() with confirmation
 * - No capability (non-voice session) → clear err()
 * - Empty text → err()
 * - Capability failure → err() with the daemon's error message
 */

import { describe, it, expect } from "vitest";
import { reportToMainSessionTool } from "../../src/tools/report_to_main_session.js";
import type { ToolCallContext } from "../../src/tools/types.js";

function createContext(overrides?: Partial<ToolCallContext>): ToolCallContext {
  return {
    sessionId: "voice-123",
    logger: () => {},
    voiceReportToMainSession: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("report_to_main_session Tool", () => {
  it("delivers the text via the capability and returns ok()", async () => {
    let captured: string | undefined;
    const result = await reportToMainSessionTool.execute(
      { text: "Der Termin ist am Freitag um 15 Uhr." },
      createContext({
        voiceReportToMainSession: async (text) => {
          captured = text;
          return { ok: true };
        },
      }),
    );
    expect(result.isError).toBe(false);
    expect(captured).toBe("Der Termin ist am Freitag um 15 Uhr.");
    expect(result.content).toContain("Main-Session");
  });

  it("returns err() when no capability is available (non-voice session)", async () => {
    const result = await reportToMainSessionTool.execute(
      { text: "Bericht" },
      createContext({ voiceReportToMainSession: undefined }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("nur in Voice-Sessions");
  });

  it("returns err() for an empty text", async () => {
    const result = await reportToMainSessionTool.execute(
      { text: "   " },
      createContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("nicht leer");
  });

  it("returns err() with the daemon's error when delivery fails", async () => {
    const result = await reportToMainSessionTool.execute(
      { text: "Bericht" },
      createContext({
        voiceReportToMainSession: async () => ({ ok: false, error: "Kein WhatsApp-Plugin aktiv" }),
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Kein WhatsApp-Plugin aktiv");
  });
});
