import { resolve } from "node:path";

import { resolveHarnessPaths } from "@harness/core";
import { readRepoInfo } from "./deploy.js";
import {
  writeRestartMarker,
  consumeRestartMarker,
  type RestartMarker,
} from "./restartMarker.js";
import { formatJid } from "../whatsapp/whitelist.js";

/**
 * Self-modification coordination for the daemon.
 *
 * The restart marker is intentionally written from the channel command
 * layer, not from the shutdown path: the request must survive even if the
 * shutdown sequence fails mid-way. A stale marker from a crashed attempt
 * is consumed-and-ignored on the next boot.
 */

/** Absolute path to the harness source repository. */
export const HARNESS_REPO_DIR = resolve(
  import.meta.dirname,
  "..", // daemon
  "..", // src
  "..", // agent
  "..", // packages
);

/** Reads the current git HEAD of the repo (short hash). */
export async function currentGitHead(repoDir: string): Promise<string> {
  const info = await readRepoInfo(repoDir);
  return info.currentHead;
}

/** Reads and consumes a pending restart marker, if one exists. */
export async function readPendingRestart(): Promise<RestartMarker | null> {
  const paths = resolveHarnessPaths();
  return consumeRestartMarker(paths.state);
}

/** Writes the restart marker for a deferred restart. */
export async function scheduleRestart(
  reason: string,
  replyTarget: string,
  gitHead: string,
  followUp?: boolean,
): Promise<void> {
  const paths = resolveHarnessPaths();
  const marker: RestartMarker = {
    timestamp: new Date().toISOString(),
    reason,
    replyTarget,
    gitHead,
    followUp: followUp === true ? true : undefined,
  };
  await writeRestartMarker(paths.state, marker);
}

/** Prompt for the post-restart follow-up turn (agent-initiated restarts). */
export const RESTART_FOLLOWUP_PROMPT = (reason: string): string =>
  `The daemon just restarted (reason: ${reason}). ` +
  "Verify briefly that the change took effect (e.g. config value loaded, key present) " +
  "and report back to the user in one or two short messages.";

/**
 * Sends the "Back online." ping for a restart marker via the channel
 * plugin's sendMessage. Best-effort: failures are warn-logged, the marker
 * is always consumed.
 *
 * When the marker requests a follow-up turn (`followUp: true`), `runFollowUp`
 * is called first — it triggers a short agent turn on the reply-target
 * session. If the follow-up fails (throws or rejects), the static ping is
 * sent as a fallback so the user always learns that the daemon is back.
 *
 * `waitForReady` (optional) is awaited before ANY send — the WhatsApp
 * connection may still be establishing right after boot, and sending
 * before it is open fails with "Connection Closed". It applies to the
 * static ping AND the follow-up turn.
 */
export async function sendRestartPing(
  marker: RestartMarker,
  sendMessage: (target: string, payload: { text: string }) => Promise<void>,
  log: (msg: string, level?: "info" | "warn" | "error", data?: Record<string, unknown>) => void,
  runFollowUp?: () => Promise<void>,
  waitForReady?: () => Promise<void>,
): Promise<void> {
  const text = `Back online. Reason: ${marker.reason}. HEAD: ${marker.gitHead}`;

  try {
    await waitForReady?.();
  } catch (err) {
    // Deadline exceeded: connection never came up. Consume the marker and
    // give up — the user is not reachable right now, retrying would only
    // produce a retry storm on every boot.
    log(
      `restart ping skipped — WhatsApp not connected: ${
        err instanceof Error ? err.message : String(err)
      } (marker consumed)`,
      "warn",
      { target: marker.replyTarget },
    );
    return;
  }

  if (marker.followUp === true && runFollowUp) {
    try {
      await runFollowUp();
      return;
    } catch (err) {
      log(
        `post-restart follow-up failed — falling back to static ping: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "warn",
      );
    }
  }

  try {
    await sendMessage(formatJid(marker.replyTarget), { text });
    log("restart ping sent", "info", { target: marker.replyTarget });
  } catch (err) {
    log(
      `restart ping failed — marker consumed anyway: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "warn",
    );
  }
}
