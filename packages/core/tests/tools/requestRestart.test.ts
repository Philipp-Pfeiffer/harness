/**
 * request_restart Tool Tests.
 *
 * Verifies:
 * - No capability (requestRestart missing) → clean error
 * - With capability → schedules deferred restart with the given reason
 * - Capability rejection (already scheduled) → error surfaced
 * - Inside a post-restart follow-up turn → refuses (loop breaker)
 */

import { describe, it, expect, vi } from "vitest";
import { requestRestartTool } from "../../src/tools/requestRestart.js";
import type { ToolCallContext } from "../../src/tools/types.js";

function createContext(overrides?: Partial<ToolCallContext>): ToolCallContext {
  return {
    sessionId: "test-session",
    requestRestart: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("request_restart Tool", () => {
  it("returns a clean error when the requestRestart capability is missing", async () => {
    const result = await requestRestartTool.execute(
      { reason: "new API key" },
      createContext({ requestRestart: undefined }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Capability fehlt");
    expect(result.content).toContain("Daemon");
  });

  it("returns a clean error when no context at all is provided", async () => {
    const result = await requestRestartTool.execute({ reason: "new API key" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Capability fehlt");
  });

  it("calls the capability with the reason and reports success", async () => {
    const requestRestart = vi.fn(async (reason: string) => {
      expect(reason).toBe("new API key added to ~/harness/.env");
      return { ok: true };
    });

    const result = await requestRestartTool.execute(
      { reason: "new API key added to ~/harness/.env" },
      createContext({ requestRestart }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Restart scheduled");
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it("surfaces an already-scheduled rejection from the capability", async () => {
    const result = await requestRestartTool.execute(
      { reason: "another restart" },
      createContext({
        requestRestart: async () => ({
          ok: false,
          error: "restart already scheduled — a restart or deploy is already pending",
        }),
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("already scheduled");
  });

  it("refuses to schedule during a post-restart follow-up turn", async () => {
    const requestRestart = vi.fn(async () => ({ ok: true }));
    const result = await requestRestartTool.execute(
      { reason: "loop attempt" },
      createContext({ requestRestart, postRestartFollowUp: true }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("post-restart follow-up");
    expect(requestRestart).not.toHaveBeenCalled();
  });
});
