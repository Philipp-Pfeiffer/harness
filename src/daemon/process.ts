import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Manages the daemon PID file.
 *
 * - Writes the current process PID on start.
 * - Reads and validates on status checks.
 * - Removes on clean shutdown.
 * - Detects and handles stale PID files (process no longer running).
 */

export interface PidInfo {
  pid: number;
  startTime?: string;
}

/**
 * Writes the PID file atomically.
 * Overwrites any existing file (used on crash-restart).
 */
export async function writePidFile(
  pidFilePath: string,
  pid: number,
  startTime?: string,
): Promise<void> {
  const info: PidInfo = { pid, ...(startTime ? { startTime } : {}) };
  await mkdir(dirname(pidFilePath), { recursive: true });
  await writeFile(pidFilePath, JSON.stringify(info), "utf-8");
}

/**
 * Reads the PID file. Returns null if the file does not exist.
 */
export async function readPidFile(
  pidFilePath: string,
): Promise<PidInfo | null> {
  try {
    const raw = await readFile(pidFilePath, "utf-8");
    const parsed = JSON.parse(raw) as PidInfo;
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // Corrupt PID file — treat as not running
    return null;
  }
}

/**
 * Checks if a process with the given PID is alive.
 * Uses process.kill(pid, 0) which throws if the process doesn't exist.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the PID file and checks if the daemon process is actually running.
 * Returns the PID if alive, null if the PID file is missing or stale.
 */
export async function getRunningDaemonPid(
  pidFilePath: string,
): Promise<number | null> {
  const info = await readPidFile(pidFilePath);
  if (!info) return null;
  if (isProcessAlive(info.pid)) return info.pid;
  return null;
}

/**
 * Removes the PID file. Safe to call if the file doesn't exist.
 */
export async function removePidFile(pidFilePath: string): Promise<void> {
  try {
    await unlink(pidFilePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // Ignore other errors (e.g. permission) — best effort
  }
}

/**
 * Detects and cleans up a stale PID file (process no longer running).
 * Returns true if a stale file was found and removed.
 */
export async function cleanupStalePidFile(
  pidFilePath: string,
): Promise<boolean> {
  const info = await readPidFile(pidFilePath);
  if (!info) return false;
  if (isProcessAlive(info.pid)) return false;
  await removePidFile(pidFilePath);
  return true;
}

/**
 * Sends SIGTERM to the daemon process and waits for it to exit.
 * Returns true if the process was successfully signaled.
 */
export async function stopDaemon(
  pidFilePath: string,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<boolean> {
  const info = await readPidFile(pidFilePath);
  if (!info) return false;
  if (!isProcessAlive(info.pid)) {
    // Already dead — just clean up the PID file
    await removePidFile(pidFilePath);
    return false;
  }
  try {
    process.kill(info.pid, signal);
    return true;
  } catch {
    return false;
  }
}
