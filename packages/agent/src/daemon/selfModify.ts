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
): Promise<void> {
  const paths = resolveHarnessPaths();
  const marker: RestartMarker = {
    timestamp: new Date().toISOString(),
    reason,
    replyTarget,
    gitHead,
  };
  await writeRestartMarker(paths.state, marker);
}

/**
 * Sends the "Back online." ping for a restart marker via the channel
 * plugin's sendMessage. Best-effort: failures are warn-logged, the marker
 * is always consumed.
 */
export async function sendRestartPing(
  marker: RestartMarker,
  sendMessage: (target: string, payload: { text: string }) => Promise<void>,
  log: (msg: string, level?: "info" | "warn" | "error", data?: Record<string, unknown>) => void,
): Promise<void> {
  const text = `Back online. Reason: ${marker.reason}. HEAD: ${marker.gitHead}`;
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
