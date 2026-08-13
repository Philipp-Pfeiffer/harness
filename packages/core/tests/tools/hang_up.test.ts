/**
 * hang_up Tool Tests.
 *
 * Verifies:
 * - Happy path: capability available → ok() with the deferred-hangup wording
 * - No capability (non-voice session) → clear err()
 * - Capability failure → err() with the daemon's error message
 */

import { describe, it, expect } from "vitest";
import { hangUpTool } from "../../src/tools/hang_up.js";
import type { ToolCallContext } from "../../src/tools/types.js";

function createContext(overrides?: Partial<ToolCallContext>): ToolCallContext {
  return {
    sessionId: "voice-123",
    logger: () => {},
    voiceHangUp: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("hang_up Tool", () => {
  it("delegates to the capability and returns ok()", async () => {
    let called = 0;
    const result = await hangUpTool.execute(
      {},
      createContext({
        voiceHangUp: async () => {
          called++;
          return { ok: true };
        },
      }),
    );
    expect(result.isError).toBe(false);
    expect(called).toBe(1);
    expect(result.content).toContain("Abschied");
  });

  it("returns err() when no capability is available (non-voice session)", async () => {
    const result = await hangUpTool.execute({}, createContext({ voiceHangUp: undefined }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("nur in Voice-Sessions");
  });

  it("returns err() with the daemon's error when the capability fails", async () => {
    const result = await hangUpTool.execute(
      {},
      createContext({
        voiceHangUp: async () => ({ ok: false, error: "Keine aktive Voice-Session" }),
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Keine aktive Voice-Session");
  });
});
