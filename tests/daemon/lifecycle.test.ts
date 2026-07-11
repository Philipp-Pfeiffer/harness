import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writePidFile,
  readPidFile,
  removePidFile,
  cleanupStalePidFile,
  isProcessAlive,
  getRunningDaemonPid,
} from "../../src/daemon/process.js";
import {
  startIpcServer,
  stopIpcServer,
  sendIpcRequest,
} from "../../src/daemon/ipc.js";
import type { IpcRequest, IpcResponse } from "../../src/daemon/types.js";

const TEST_DIR = join(
  tmpdir(),
  `harness-lifecycle-test-${process.pid}-${Date.now()}`,
);
const PID_FILE = join(TEST_DIR, "daemon.pid");
const SOCKET_FILE = join(TEST_DIR, "daemon.sock");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

/* ──────────────────────────────────────────────────────────────
 * Integration: Stale-PID Detection (simulates DaemonRuntime.start flow)
 * ────────────────────────────────────────────────────────────── */

describe("Stale-PID detection (daemon start flow)", () => {
  it("detects and removes stale PID file from crashed daemon, then writes fresh PID", async () => {
    // Simulate a crashed daemon: write a PID file pointing to a dead process
    await writePidFile(PID_FILE, 999999, "2026-01-01T00:00:00Z");
    expect(await readPidFile(PID_FILE)).not.toBeNull();

    // This is what DaemonRuntime.start() does:
    const wasStale = await cleanupStalePidFile(PID_FILE);
    expect(wasStale).toBe(true);
    expect(await readPidFile(PID_FILE)).toBeNull();

    // Write fresh PID file (the new daemon instance)
    const startTime = new Date().toISOString();
    await writePidFile(PID_FILE, process.pid, startTime);

    const info = await readPidFile(PID_FILE);
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(process.pid);
    expect(info!.startTime).toBe(startTime);
  });

  it("does not remove PID file when daemon is still alive", async () => {
    // Write a PID file pointing to the current test process
    await writePidFile(PID_FILE, process.pid);

    const wasStale = await cleanupStalePidFile(PID_FILE);
    expect(wasStale).toBe(false);

    const info = await readPidFile(PID_FILE);
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(process.pid);
  });

  it("returns false when no PID file exists (fresh start)", async () => {
    const wasStale = await cleanupStalePidFile(PID_FILE);
    expect(wasStale).toBe(false);
  });

  it("handles corrupt PID file gracefully during stale detection", async () => {
    // Write a corrupt PID file (not valid JSON)
    await writeFile(PID_FILE, "NOT-JSON-AT-ALL", "utf-8");

    // readPidFile returns null for corrupt files, so cleanupStalePidFile
    // should return false (nothing to clean) rather than throwing
    const wasStale = await cleanupStalePidFile(PID_FILE);
    expect(wasStale).toBe(false);
  });

  it("getRunningDaemonPid returns null after stale cleanup", async () => {
    // Write stale PID
    await writePidFile(PID_FILE, 999999);

    // Before cleanup: PID is detected as stale (process dead)
    expect(await getRunningDaemonPid(PID_FILE)).toBeNull();

    // After cleanup: file is gone
    await cleanupStalePidFile(PID_FILE);
    expect(await getRunningDaemonPid(PID_FILE)).toBeNull();
    expect(await readPidFile(PID_FILE)).toBeNull();
  });
});

/* ──────────────────────────────────────────────────────────────
 * Integration: PID- and Socket-File Cleanup after clean stop
 * (simulates DaemonRuntime.shutdown flow)
 * ────────────────────────────────────────────────────────────── */

describe("PID- and Socket-File cleanup after clean stop", () => {
  it("removes both PID file and socket file on clean shutdown", async () => {
    // ── Simulate daemon start: write PID + start IPC server ──
    const startTime = new Date().toISOString();
    await writePidFile(PID_FILE, process.pid, startTime);

    const server = await startIpcServer(SOCKET_FILE, async (
      req: IpcRequest,
    ): Promise<IpcResponse> => {
      if (req.type === "ping") {
        return { type: "pong", uptime: 5, pid: process.pid };
      }
      return { type: "error", message: "unknown" };
    });

    // Verify both files exist
    expect(await readPidFile(PID_FILE)).not.toBeNull();
    await expect(stat(SOCKET_FILE)).resolves.toBeDefined();

    // Verify the daemon is responsive
    const pingResp = await sendIpcRequest(SOCKET_FILE, { type: "ping" });
    expect(pingResp.type).toBe("pong");

    // ── Simulate daemon shutdown ──
    await stopIpcServer(server, SOCKET_FILE);
    await removePidFile(PID_FILE);

    // Verify both files are gone
    expect(await readPidFile(PID_FILE)).toBeNull();
    await expect(stat(SOCKET_FILE)).rejects.toThrow();
  });

  it("removes socket file even if PID file was already missing", async () => {
    // Start IPC server without a PID file (e.g., PID file was lost)
    const server = await startIpcServer(SOCKET_FILE, async () => ({
      type: "pong" as const,
      uptime: 0,
      pid: 0,
    }));

    await stopIpcServer(server, SOCKET_FILE);
    await removePidFile(PID_FILE); // should not throw

    // Socket is gone
    await expect(stat(SOCKET_FILE)).rejects.toThrow();
    expect(await readPidFile(PID_FILE)).toBeNull();
  });

  it("removes PID file even if IPC server was already closed", async () => {
    // Write PID file
    await writePidFile(PID_FILE, process.pid);

    // Start and immediately stop IPC server
    const server = await startIpcServer(SOCKET_FILE, async () => ({
      type: "pong" as const,
      uptime: 0,
      pid: 0,
    }));
    await stopIpcServer(server, SOCKET_FILE);

    // Remove PID file after IPC is already down
    await removePidFile(PID_FILE);

    expect(await readPidFile(PID_FILE)).toBeNull();
    await expect(stat(SOCKET_FILE)).rejects.toThrow();
  });

  it("full lifecycle: stale cleanup → fresh start → serve → clean stop", async () => {
    // ── Phase 1: Previous daemon crashed, stale PID file exists ──
    await writePidFile(PID_FILE, 999999, "2026-01-01T00:00:00Z");

    // ── Phase 2: New daemon starts — cleans up stale, writes fresh ──
    const wasStale = await cleanupStalePidFile(PID_FILE);
    expect(wasStale).toBe(true);

    const startTime = new Date().toISOString();
    await writePidFile(PID_FILE, process.pid, startTime);

    const server = await startIpcServer(SOCKET_FILE, async (
      req: IpcRequest,
    ): Promise<IpcResponse> => {
      if (req.type === "ping") {
        return { type: "pong", uptime: 0, pid: process.pid };
      }
      if (req.type === "status") {
        return {
          type: "status",
          daemon: {
            pid: process.pid,
            uptime: 0,
            startTime,
            model: "test",
            gateways: "none configured",
            lastErrors: [],
            sessionsActive: 1,
            turnsCompleted: 0,
          },
        };
      }
      return { type: "error", message: "unknown" };
    });

    // ── Phase 3: Daemon is serving ──
    const pingResp = await sendIpcRequest(SOCKET_FILE, { type: "ping" });
    expect(pingResp.type).toBe("pong");

    const statusResp = await sendIpcRequest(SOCKET_FILE, { type: "status" });
    expect(statusResp.type).toBe("status");

    // Both files exist during operation
    expect(await readPidFile(PID_FILE)).not.toBeNull();
    await expect(stat(SOCKET_FILE)).resolves.toBeDefined();

    // ── Phase 4: Clean shutdown ──
    await stopIpcServer(server, SOCKET_FILE);
    await removePidFile(PID_FILE);

    // Both files are cleaned up
    expect(await readPidFile(PID_FILE)).toBeNull();
    await expect(stat(SOCKET_FILE)).rejects.toThrow();

    // Process (this test) is still alive — confirms we didn't kill ourselves
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
