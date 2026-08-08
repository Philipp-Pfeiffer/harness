import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, RunResult, Model } from "@harness/core";
import type { Api } from "@mariozechner/pi-ai";
import { DaemonRuntime } from "../../src/daemon/runtime.js";
import type { ConfigModel } from "../../src/config.js";
import { RESTART_MARKER_FILE } from "../../src/daemon/restartMarker.js";
import * as deployModule from "../../src/daemon/deploy.js";
import * as selfModifyModule from "../../src/daemon/selfModify.js";

vi.mock("../../src/daemon/deploy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/daemon/deploy.js")>();
  return actual;
});

vi.mock("../../src/daemon/selfModify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/daemon/selfModify.js")>();
  return actual;
});

const TEST_DIR = join(tmpdir(), `harness-selfmod-${process.pid}-${Date.now()}`);

let savedHome: string | undefined;
let savedState: string | undefined;

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(join(TEST_DIR, "state", "logs"), { recursive: true });
  savedHome = process.env.HARNESS_HOME;
  savedState = process.env.HARNESS_STATE;
  process.env.HARNESS_HOME = join(TEST_DIR, "home");
  process.env.HARNESS_STATE = join(TEST_DIR, "state");
  vi.restoreAllMocks();
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHome;
  if (savedState === undefined) delete process.env.HARNESS_STATE;
  else process.env.HARNESS_STATE = savedState;
  await rm(TEST_DIR, { recursive: true, force: true });
});

function createFakeModel(): Model<Api> {
  return {
    name: "fake-default",
    id: "fake-default-id",
    provider: "fake",
    setApiKey() {},
  } as unknown as Model<Api>;
}

function createFakeAgent(): Agent {
  return {
    setModel() {},
    setSystemPrompt() {},
    async run(): Promise<RunResult> {
      return {
        aborted: false,
        turns: 0,
        finalMessage: "ok",
        toolCallCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
  } as unknown as Agent;
}

const MODELS: ConfigModel[] = [
  { provider: "openai", model: "gpt-5.2", alias: "GPT 5.2" },
];

type RuntimeInternals = {
  agent: Agent;
  model: Model<Api>;
  configModels: ConfigModel[];
  turnActive: boolean;
  shutdownWithExit: (signal: string | undefined, exitCode: number) => Promise<void>;
};

function makeRuntime(): DaemonRuntime {
  const runtime = new DaemonRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  internals.agent = createFakeAgent();
  internals.model = createFakeModel();
  internals.configModels = MODELS;
  return runtime;
}

/** Mocks the private shutdownWithExit so no real process.exit runs. */
function mockShutdown(runtime: DaemonRuntime): ReturnType<typeof vi.fn> {
  const internals = runtime as unknown as RuntimeInternals;
  const spy = vi.fn().mockResolvedValue(undefined);
  internals.shutdownWithExit = spy;
  return spy;
}

function markerFile(): string {
  return join(process.env.HARNESS_STATE!, RESTART_MARKER_FILE);
}

/** Lets a scheduled setImmediate callback run (used for the no-turn restart). */
async function flushImmediate(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

async function readMarker(): Promise<Record<string, string> | null> {
  try {
    const raw = await readFile(markerFile(), "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

describe("deferred restart", () => {
  it("does not exit while a turn is running; after the turn the shutdown path (exit 1) runs and the marker is written", async () => {
    vi.spyOn(selfModifyModule, "currentGitHead").mockResolvedValue("mockhead1");
    const runtime = makeRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    const shutdownSpy = mockShutdown(runtime);

    // Turn running → requestRestartAfterTurn must NOT exit.
    internals.turnActive = true;
    await runtime.requestRestartAfterTurn("deploy feat/x", "491701234567");
    expect(shutdownSpy).not.toHaveBeenCalled();
    const marker = await readMarker();
    expect(marker?.reason).toBe("deploy feat/x");
    expect(marker?.replyTarget).toBe("491701234567");
    expect(marker?.gitHead).toBe("mockhead1");

    // Turn finished → shutdown path with exit code 1 runs.
    internals.turnActive = false;
    await runtime.requestRestartAfterTurn("deploy feat/x", "491701234567");
    await flushImmediate();
    expect(shutdownSpy).toHaveBeenCalledWith("self-restart", 1);
  });
});

describe("restart marker boot ping", () => {
  it("sends a ping on boot when a marker exists and consumes the marker", async () => {
    await writeFile(
      markerFile(),
      JSON.stringify({
        timestamp: "2026-08-08T10:00:00.000Z",
        reason: "deploy feat/x",
        replyTarget: "491701234567",
        gitHead: "abc1234",
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    const sendMock = vi.fn().mockResolvedValue(undefined);
    (
      runtime as unknown as {
        channelPlugins: Map<string, { sendMessage: (t: string, p: unknown) => Promise<void> }>;
      }
    ).channelPlugins.set("whatsapp", { sendMessage: sendMock });

    // Same sequence the start() hook performs.
    const marker = await selfModifyModule.readPendingRestart();
    expect(marker).not.toBeNull();
    const logFn = vi.fn();
    await selfModifyModule.sendRestartPing(marker!, (t, p) => sendMock(t, p), logFn);

    expect(sendMock).toHaveBeenCalledWith(
      "491701234567@s.whatsapp.net",
      expect.objectContaining({ text: expect.stringContaining("Back online") }),
    );
    // Marker consumed (removed).
    await expect(readFile(markerFile())).rejects.toThrow();
  });

  it("does nothing on boot when no marker exists", async () => {
    const marker = await selfModifyModule.readPendingRestart();
    expect(marker).toBeNull();
  });
});

describe("/deploy channel command", () => {
  it("rejects /deploy on main", async () => {
    const runtime = makeRuntime();
    const result = await runtime.handleChannelSlashCommand("s1", "/deploy main");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("not supported");
  });

  it("returns null for /deploy without a branch argument", async () => {
    const runtime = makeRuntime();
    const result = await runtime.handleChannelSlashCommand("s1", "/deploy");
    expect(result).toBeNull();
  });

  it("failure path: build/test failure → error response, main restored, no restart", async () => {
    const runtime = makeRuntime();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    vi.spyOn(deployModule, "runDeploy").mockResolvedValue({
      ok: false,
      message: "Deploy failed: build or test errored. Main reset to abc1234.",
    });

    const result = await runtime.handleChannelSlashCommand("s1", "/deploy feat/x");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("Deploy failed");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(await readMarker()).toBeNull();

    exitSpy.mockRestore();
  });

  it("success path: marker + requestRestartAfterTurn, no turn → restart now", async () => {
    const runtime = makeRuntime();
    const shutdownSpy = mockShutdown(runtime);
    vi.spyOn(deployModule, "runDeploy").mockResolvedValue({
      ok: true,
      message: "Deploy prepared.",
      gitHead: "newhash123",
    });

    const result = await runtime.handleChannelSlashCommand("s1", "/deploy feat/x");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("Deploy prepared, restarting");
    const marker = await readMarker();
    expect(marker?.reason).toBe("deploy feat/x");
    expect(marker?.gitHead).toBe("newhash123");
    await flushImmediate();
    expect(shutdownSpy).toHaveBeenCalledWith("self-restart", 1);
  });

  it("success path while a turn is running: deferred restart, marker written", async () => {
    const runtime = makeRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    const shutdownSpy = mockShutdown(runtime);
    internals.turnActive = true;
    vi.spyOn(deployModule, "runDeploy").mockResolvedValue({
      ok: true,
      message: "Deploy prepared.",
      gitHead: "newhash123",
    });

    const result = await runtime.handleChannelSlashCommand("s1", "/deploy feat/x");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("after the current turn finishes");
    expect(shutdownSpy).not.toHaveBeenCalled();
    const marker = await readMarker();
    expect(marker?.reason).toBe("deploy feat/x");
  });

  it("double invocation → lock guards the second call", async () => {
    const runtime = makeRuntime();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(deployModule, "runDeploy").mockImplementation(async () => {
      await gate;
      return { ok: true, message: "Deploy prepared.", gitHead: "abc" };
    });
    mockShutdown(runtime);

    // First call is in flight (awaiting the gate).
    const first = runtime.handleChannelSlashCommand("s1", "/deploy feat/x");
    await new Promise((r) => setTimeout(r, 20));

    // Second call must be rejected by the lock.
    const second = await runtime.handleChannelSlashCommand("s1", "/deploy feat/y");
    expect(second).not.toBeNull();
    expect(second!.response).toContain("already in progress");

    release();
    await first;
  });
});

describe("/restart channel command", () => {
  it("schedules marker + restart without build steps", async () => {
    vi.spyOn(selfModifyModule, "currentGitHead").mockResolvedValue("mockhead");
    const runtime = makeRuntime();
    const shutdownSpy = mockShutdown(runtime);
    const deploySpy = vi.spyOn(deployModule, "runDeploy");

    const result = await runtime.handleChannelSlashCommand("s1", "/restart");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("Restarting");
    expect(deploySpy).not.toHaveBeenCalled();
    await flushImmediate();
    expect(shutdownSpy).toHaveBeenCalledWith("self-restart", 1);

    const marker = await readMarker();
    expect(marker?.reason).toBe("manual /restart");
    expect(marker?.replyTarget).toBe("");
    expect(marker?.gitHead).toBe("mockhead");
  });

  it("during a running turn: deferred, responds with scheduled message", async () => {
    vi.spyOn(selfModifyModule, "currentGitHead").mockResolvedValue("mockhead");
    const runtime = makeRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    const shutdownSpy = mockShutdown(runtime);
    internals.turnActive = true;

    const result = await runtime.handleChannelSlashCommand("s1", "/restart");
    expect(result).not.toBeNull();
    expect(result!.response).toContain("Restart scheduled");
    expect(shutdownSpy).not.toHaveBeenCalled();

    const marker = await readMarker();
    expect(marker?.reason).toBe("manual /restart");
  });
});
