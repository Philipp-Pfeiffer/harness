import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
  getRunningDaemonPid,
  cleanupStalePidFile,
  stopDaemon,
} from "../../src/daemon/process.js";

const TEST_DIR = join(tmpdir(), `harness-pid-test-${process.pid}-${Date.now()}`);

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("PID file management", () => {
  it("writes and reads a PID file", async () => {
    const pidFile = join(TEST_DIR, "daemon.pid");
    await writePidFile(pidFile, 12345, "2026-01-01T00:00:00Z");

    const info = await readPidFile(pidFile);
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(12345);
    expect(info!.startTime).toBe("2026-01-01T00:00:00Z");
  });

  it("returns null when PID file does not exist", async () => {
    const info = await readPidFile(join(TEST_DIR, "nonexistent.pid"));
    expect(info).toBeNull();
  });

  it("returns null for corrupt PID file", async () => {
    const pidFile = join(TEST_DIR, "corrupt.pid");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(TEST_DIR, { recursive: true });
    await writeFile(pidFile, "not valid json{}", "utf-8");

    const info = await readPidFile(pidFile);
    expect(info).toBeNull();
  });

  it("removes PID file", async () => {
    const pidFile = join(TEST_DIR, "daemon.pid");
    await writePidFile(pidFile, 12345);
    await removePidFile(pidFile);

    const info = await readPidFile(pidFile);
    expect(info).toBeNull();
  });

  it("removePidFile is safe when file doesn't exist", async () => {
    const pidFile = join(TEST_DIR, "nonexistent.pid");
    await expect(removePidFile(pidFile)).resolves.toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  it("returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for non-existent PID", () => {
    // PID 999999 is very unlikely to exist
    expect(isProcessAlive(999999)).toBe(false);
  });
});

describe("getRunningDaemonPid", () => {
  it("returns current PID when PID file points to current process", async () => {
    const pidFile = join(TEST_DIR, "daemon.pid");
    await writePidFile(pidFile, process.pid);

    const pid = await getRunningDaemonPid(pidFile);
    expect(pid).toBe(process.pid);
  });

  it("returns null when PID file is missing", async () => {
    const pid = await getRunningDaemonPid(join(TEST_DIR, "nonexistent.pid"));
    expect(pid).toBeNull();
  });

  it("returns null when process is dead", async () => {
    const pidFile = join(TEST_DIR, "daemon.pid");
    await writePidFile(pidFile, 999999); // non-existent PID

    const pid = await getRunningDaemonPid(pidFile);
    expect(pid).toBeNull();
  });
});

describe("cleanupStalePidFile", () => {
  it("detects and removes stale PID file", async () => {
    const pidFile = join(TEST_DIR, "daemon.pid");
    await writePidFile(pidFile, 999999); // dead PID

    const cleaned = await cleanupStalePidFile(pidFile);
    expect(cleaned).toBe(true);

    const info = await readPidFile(pidFile);
    expect(info).toBeNull();
  });

  it("returns false when PID file doesn't exist", async () => {
    const cleaned = await cleanupStalePidFile(join(TEST_DIR, "nonexistent.pid"));
    expect(cleaned).toBe(false);
  });

  it("returns false when process is still alive", async () => {
    const pidFile = join(TEST_DIR, "daemon.pid");
    await writePidFile(pidFile, process.pid);

    const cleaned = await cleanupStalePidFile(pidFile);
    expect(cleaned).toBe(false);
  });
});

describe("stopDaemon", () => {
  it("returns false when PID file is missing", async () => {
    const result = await stopDaemon(join(TEST_DIR, "nonexistent.pid"));
    expect(result).toBe(false);
  });

  it("cleans up PID file when process is already dead", async () => {
    const pidFile = join(TEST_DIR, "daemon.pid");
    await writePidFile(pidFile, 999999); // dead PID

    const result = await stopDaemon(pidFile);
    expect(result).toBe(false);

    const info = await readPidFile(pidFile);
    expect(info).toBeNull();
  });
});
