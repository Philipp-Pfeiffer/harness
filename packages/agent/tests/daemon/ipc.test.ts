import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startIpcServer, sendIpcRequest, stopIpcServer } from "../../src/daemon/ipc.js";
import type { IpcRequest, IpcResponse } from "../../src/daemon/types.js";

const TEST_DIR = join(tmpdir(), `harness-ipc-test-${process.pid}-${Date.now()}`);

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("IPC server + client", () => {
  it("starts server, sends ping, receives pong", async () => {
    const socketPath = join(TEST_DIR, "daemon.sock");

    const server = await startIpcServer(socketPath, async (req: IpcRequest): Promise<IpcResponse> => {
      if (req.type === "ping") {
        return { type: "pong", uptime: 42, pid: process.pid };
      }
      return { type: "error", message: "unknown" };
    });

    try {
      const resp = await sendIpcRequest(socketPath, { type: "ping" });
      expect(resp.type).toBe("pong");
      expect(resp).toMatchObject({ type: "pong", uptime: 42, pid: process.pid });
    } finally {
      await stopIpcServer(server, socketPath);
    }
  });

  it("handles status request", async () => {
    const socketPath = join(TEST_DIR, "daemon.sock");

    const server = await startIpcServer(socketPath, async (req: IpcRequest): Promise<IpcResponse> => {
      if (req.type === "status") {
        return {
          type: "status",
          daemon: {
            pid: process.pid,
            uptime: 100,
            startTime: "2026-01-01T00:00:00Z",
            model: "test-model",
            gateways: "none configured",
            lastErrors: [],
            sessionsActive: 1,
            turnsCompleted: 5,
          },
        };
      }
      return { type: "error", message: "unknown" };
    });

    try {
      const resp = await sendIpcRequest(socketPath, { type: "status" });
      expect(resp.type).toBe("status");
      if (resp.type === "status") {
        expect(resp.daemon.pid).toBe(process.pid);
        expect(resp.daemon.uptime).toBe(100);
        expect(resp.daemon.model).toBe("test-model");
        expect(resp.daemon.gateways).toBe("none configured");
      }
    } finally {
      await stopIpcServer(server, socketPath);
    }
  });

  it("rejects when server is not running", async () => {
    const socketPath = join(TEST_DIR, "nonexistent.sock");

    await expect(
      sendIpcRequest(socketPath, { type: "ping" }, 1000),
    ).rejects.toThrow();
  });

  it("handles shutdown request", async () => {
    const socketPath = join(TEST_DIR, "daemon.sock");
    let shutdownCalled = false;

    const server = await startIpcServer(socketPath, async (req: IpcRequest): Promise<IpcResponse> => {
      if (req.type === "shutdown") {
        shutdownCalled = true;
        return { type: "shutting-down" };
      }
      return { type: "error", message: "unknown" };
    });

    try {
      const resp = await sendIpcRequest(socketPath, { type: "shutdown" });
      expect(resp.type).toBe("shutting-down");
      expect(shutdownCalled).toBe(true);
    } finally {
      await stopIpcServer(server, socketPath);
    }
  });

  it("handles reload-config request", async () => {
    const socketPath = join(TEST_DIR, "daemon.sock");

    const server = await startIpcServer(socketPath, async (req: IpcRequest): Promise<IpcResponse> => {
      if (req.type === "reload-config") {
        return { type: "config-reloaded", ok: true, message: "Config reloaded." };
      }
      return { type: "error", message: "unknown" };
    });

    try {
      const resp = await sendIpcRequest(socketPath, { type: "reload-config" });
      expect(resp.type).toBe("config-reloaded");
      if (resp.type === "config-reloaded") {
        expect(resp.ok).toBe(true);
        expect(resp.message).toBe("Config reloaded.");
      }
    } finally {
      await stopIpcServer(server, socketPath);
    }
  });

  it("stops server and removes socket file", async () => {
    const socketPath = join(TEST_DIR, "daemon.sock");

    const server = await startIpcServer(socketPath, async () => ({
      type: "pong" as const,
      uptime: 0,
      pid: 0,
    }));

    await stopIpcServer(server, socketPath);

    // Socket file should be gone
    const { stat } = await import("node:fs/promises");
    await expect(stat(socketPath)).rejects.toThrow();
  });
});
