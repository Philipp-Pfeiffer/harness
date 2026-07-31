import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  cdpUrlForPort,
  findFreePort,
  parseCdpPort,
  startObscura,
  stopObscuraProcess,
  waitForCdp,
} from "../../src/browser/obscura.js";
import { BrowserConnectionError } from "../../src/browser/errors.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function createMockChildProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  Object.assign(proc, {
    pid: 4242,
    killed: false,
    exitCode: null,
    kill: vi.fn((signal?: string) => {
      proc.killed = signal === "SIGKILL" || proc.killed;
      queueMicrotask(() => {
        proc.exitCode = signal === "SIGKILL" ? 137 : 0;
        proc.emit("exit", proc.exitCode, signal ?? null);
      });
    }),
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
  });
  return proc;
}

describe("obscura helpers", () => {
  it("builds cdp urls from ports", () => {
    expect(cdpUrlForPort(9222)).toBe("http://127.0.0.1:9222");
  });

  it("parses cdp ports", () => {
    expect(parseCdpPort("http://127.0.0.1:9222")).toBe(9222);
    expect(parseCdpPort("http://127.0.0.1")).toBe(80);
  });

  it("allocates a free local port", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
  });
});

describe("waitForCdp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves when /json/version responds", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    await expect(waitForCdp("http://127.0.0.1:9222", 1_000)).resolves.toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9222/json/version",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("times out when CDP never becomes ready", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    await expect(waitForCdp("http://127.0.0.1:9222", 300)).rejects.toBeInstanceOf(BrowserConnectionError);
  });
});

describe("startObscura", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns obscura serve on a free port and returns a stop handle", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

    const session = await startObscura({ port: 9444, startupTimeoutMs: 1_000 });

    expect(spawnMock).toHaveBeenCalledWith(
      "obscura",
      ["serve", "--port", "9444"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(session.cdpUrl).toBe("http://127.0.0.1:9444");
    expect(session.port).toBe(9444);

    await session.stop();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses OBSCURA_PATH when provided", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

    const prev = process.env.OBSCURA_PATH;
    process.env.OBSCURA_PATH = "/usr/bin/obscura-custom";
    try {
      await startObscura({ port: 9555, startupTimeoutMs: 1_000 });
      expect(spawnMock).toHaveBeenCalledWith(
        "/usr/bin/obscura-custom",
        ["serve", "--port", "9555"],
        expect.any(Object),
      );
    } finally {
      if (prev === undefined) delete process.env.OBSCURA_PATH;
      else process.env.OBSCURA_PATH = prev;
    }
  });

  it("fails when obscura exits before CDP is ready", async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    const pending = startObscura({ port: 9666, startupTimeoutMs: 500 });
    proc.stderr?.emit("data", Buffer.from("boom"));
    queueMicrotask(() => proc.emit("exit", 1, null));

    await expect(pending).rejects.toThrow(/Obscura exited before CDP was ready/);
  });
});

describe("stopObscuraProcess", () => {
  it("escalates from SIGTERM to SIGKILL", async () => {
    const proc = createMockChildProcess();
    const kill = vi.spyOn(proc, "kill").mockImplementation((signal?: string) => {
      if (signal === "SIGKILL") {
        proc.exitCode = 137;
        proc.emit("exit", 137, "SIGKILL");
      }
    });

    const pending = stopObscuraProcess(proc);
    await expect(pending).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });
});
