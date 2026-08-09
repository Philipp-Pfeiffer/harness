import { describe, it, expect, vi } from "vitest";
import { waitForChannelReady } from "../../src/daemon/restartPing.js";
import { sendRestartPing } from "../../src/daemon/selfModify.js";
import { formatJid } from "../../src/whatsapp/whitelist.js";
import type { RestartMarker } from "../../src/daemon/restartMarker.js";

function marker(overrides: Partial<RestartMarker> = {}): RestartMarker {
  return {
    timestamp: "2026-08-09T10:00:00.000Z",
    reason: "deploy feat/x",
    replyTarget: "491701234567",
    gitHead: "abc1234",
    ...overrides,
  };
}

describe("waitForChannelReady", () => {
  it("resolves immediately when the channel is already connected", async () => {
    const plugin = { healthCheck: vi.fn(async () => true) };
    await waitForChannelReady(plugin, vi.fn(), 1_000, 5);
    expect(plugin.healthCheck).toHaveBeenCalledTimes(1);
  });

  it("polls until the connection is open", async () => {
    const results = [false, false, true];
    let call = 0;
    const plugin = { healthCheck: vi.fn(async () => results[call++] ?? false) };
    await waitForChannelReady(plugin, vi.fn(), 1_000, 5);
    expect(plugin.healthCheck).toHaveBeenCalledTimes(3);
  });

  it("rejects after the deadline when the connection never comes up", async () => {
    const plugin = { healthCheck: vi.fn(async () => false) };
    await expect(waitForChannelReady(plugin, vi.fn(), 30, 5)).rejects.toThrow(
      "WhatsApp channel not connected within 30ms",
    );
  });
});

describe("sendRestartPing connection-ready gating", () => {
  it("waits for connection ready — send fails while disconnected, user gets the message once connected", async () => {
    // Channel is down for the first two readiness checks ("send fails 2×"),
    // then the connection opens and the ping goes through.
    const results = [false, false, true];
    let call = 0;
    const plugin = { healthCheck: vi.fn(async () => results[call++] ?? false) };
    const send = vi.fn().mockResolvedValue(undefined);

    await sendRestartPing(
      marker(),
      send,
      vi.fn(),
      undefined,
      () => waitForChannelReady(plugin, vi.fn(), 1_000, 5),
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      formatJid("491701234567"),
      expect.objectContaining({ text: expect.stringContaining("Back online") }),
    );
  });

  it("timeout → no send, warn logged (marker consumed)", async () => {
    const plugin = { healthCheck: vi.fn(async () => false) };
    const send = vi.fn();
    const log = vi.fn();

    await sendRestartPing(
      marker(),
      send,
      log,
      undefined,
      () => waitForChannelReady(plugin, vi.fn(), 20, 5),
    );

    expect(send).not.toHaveBeenCalled();
    expect(
      log.mock.calls.some(
        ([msg, level]) =>
          String(msg).includes("restart ping skipped") &&
          String(msg).includes("marker consumed") &&
          level === "warn",
      ),
    ).toBe(true);
  });

  it("waits for the channel before a follow-up turn", async () => {
    const plugin = { healthCheck: vi.fn(async () => true) };
    const followUp = vi.fn(async () => {});
    const wait = vi.fn(() => waitForChannelReady(plugin, vi.fn(), 1_000, 5));

    await sendRestartPing(marker({ followUp: true }), vi.fn(), vi.fn(), followUp, wait);

    expect(wait).toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it("without waitForReady, behaves as before (no gating)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await sendRestartPing(marker(), send, vi.fn());
    expect(send).toHaveBeenCalledTimes(1);
  });
});
