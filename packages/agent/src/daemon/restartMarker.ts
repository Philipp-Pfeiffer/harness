import { readFile, writeFile, unlink, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

/**
 * Persisted intent for a deferred self-restart.
 *
 * Written before the daemon exits (exit code 1 → systemd restarts) so the
 * next boot can report back to the requesting channel. Kept in
 * $HARNESS_STATE (ephemeral, regenerable) — never in HARNESS_HOME.
 */
export interface RestartMarker {
  /** ISO timestamp when the restart was requested. */
  timestamp: string;
  /** Human-readable reason, e.g. "deploy feat/foo" or "manual /restart". */
  reason: string;
  /** WhatsApp JID / phone number of the session that triggered the restart. */
  replyTarget: string;
  /** Commit the daemon was running when the restart was requested. */
  gitHead: string;
}

/** File name of the restart marker inside $HARNESS_STATE. */
export const RESTART_MARKER_FILE = "pending-restart.json";

/**
 * Writes the restart marker atomically (temp file + rename).
 * @param stateDir $HARNESS_STATE
 */
export async function writeRestartMarker(
  stateDir: string,
  marker: RestartMarker,
): Promise<void> {
  const file = join(stateDir, RESTART_MARKER_FILE);
  await mkdir(stateDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(marker, null, 2) + "\n", "utf-8");
  await rename(tmp, file);
}

/**
 * Reads and removes the restart marker in one step. Returns the marker
 * if it existed, null otherwise. Corrupt/invalid markers are treated as
 * absent (and removed) — a stale marker must never block startup or
 * trigger a retry storm.
 */
export async function consumeRestartMarker(
  stateDir: string,
): Promise<RestartMarker | null> {
  const file = join(stateDir, RESTART_MARKER_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }

  await unlink(file).catch(() => {});

  try {
    const parsed = JSON.parse(raw) as Partial<RestartMarker>;
    if (
      typeof parsed.timestamp !== "string" ||
      typeof parsed.reason !== "string" ||
      typeof parsed.replyTarget !== "string" ||
      typeof parsed.gitHead !== "string"
    ) {
      return null;
    }
    return {
      timestamp: parsed.timestamp,
      reason: parsed.reason,
      replyTarget: parsed.replyTarget,
      gitHead: parsed.gitHead,
    };
  } catch {
    return null;
  }
}
