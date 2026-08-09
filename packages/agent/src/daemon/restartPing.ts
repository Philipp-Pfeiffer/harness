/**
 * Restart-ping channel-readiness coordination.
 *
 * On boot the daemon reports "Back online." (static ping) or runs a short
 * follow-up turn within seconds, but the Baileys connection is often still
 * establishing — a send at that point fails with "Connection Closed" and
 * the user never hears back. These helpers wait until the channel actually
 * reports ready before any send, and give up (with a warn) only after the
 * configured deadline so the marker is always consumed.
 */

import type { ChannelPlugin } from "./types.js";

/** Total wall-clock budget for waiting until the channel is ready. */
export const RESTART_WAIT_TIMEOUT_MS = 60_000;

/** Interval between readiness polls. */
export const RESTART_WAIT_POLL_MS = 500;

/**
 * Waits until the WhatsApp channel reports ready (connection open).
 *
 * Polls `plugin.healthCheck()` (backed by the Baileys client's
 * `isConnected()`) every `pollMs` up to `timeoutMs`. Resolves immediately
 * if already connected. Rejects after the deadline with a descriptive
 * error; the caller then falls back to the current behavior (warn +
 * consume marker).
 */
export async function waitForChannelReady(
  plugin: Pick<ChannelPlugin, "healthCheck">,
  log: (msg: string, level?: "info" | "warn", data?: Record<string, unknown>) => void,
  timeoutMs = RESTART_WAIT_TIMEOUT_MS,
  pollMs = RESTART_WAIT_POLL_MS,
): Promise<void> {
  if (await plugin.healthCheck()) return;

  const deadline = Date.now() + timeoutMs;
  log(`restart ping: waiting up to ${timeoutMs}ms for WhatsApp connection`, "info");

  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await plugin.healthCheck()) {
      log("restart ping: WhatsApp connection ready", "info");
      return;
    }
  }

  throw new Error(
    `WhatsApp channel not connected within ${timeoutMs}ms — restart ping skipped`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
