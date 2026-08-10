import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, RunResult, Model, HarnessPaths } from "@harness/core";
import type { Message } from "@mariozechner/pi-ai";
import type { Api } from "@mariozechner/pi-ai";
import { DaemonRuntime } from "../../src/daemon/runtime.js";
import type { ConfigModel } from "../../src/config.js";
import { RESTART_MARKER_FILE } from "../../src/daemon/restartMarker.js";
import { createSession, type Session } from "../../src/core/session.js";
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

/**
 * Fake agent that records the RunOptions of each run() call. The follow-up
 * handler can then inspect/attach the injected requestRestart capability.
 */
function createRecordingFakeAgent(): {
  agent: Agent;
  captured: Array<Record<string, unknown>>;
} {
  const captured: Array<Record<string, unknown>> = [];
  const agent: Agent = {
    setModel() {},
    setSystemPrompt() {},
    async run(_messages: Message[], options: Record<string, unknown>): Promise<RunResult> {
      captured.push(options);
      return {
        aborted: false,
        turns: 1,
        finalMessage: "Follow-up OK",
        toolCallCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
  } as unknown as Agent;
  return { agent, captured };
}

/** Registers a session entry (WhatsApp origin + source mapping) on the runtime. */
async function registerWhatsAppSession(
  runtime: DaemonRuntime,
  phone: string,
): Promise<string> {
  const paths = (runtime as unknown as { paths: HarnessPaths }).paths;
  const session = await createSession(paths, {
    model: "fake-default",
    title: `WhatsApp: ${phone}`,
    origin: "whatsapp",
  });
  const internals = runtime as unknown as {
    sessions: Map<string, unknown>;
    whatsappSessionToSource: Map<string, string>;
    whatsappSessions: Map<string, string>;
  };
  internals.sessions.set(session.id, {
    session,
    messages: [],
    turnsCompleted: 0,
    metricsRecorder: { recordTurn() {}, recordToolCall() {}, recordRetry() {} },
    origin: "whatsapp",
    title: `WhatsApp: ${phone}`,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActivityAt,
    profile: "default",
    mailbox: { push() {}, drainAll: () => [] },
    turnQueue: Promise.resolve(),
  });
  internals.whatsappSessionToSource.set(session.id, phone);
  internals.whatsappSessions.set(phone, session.id);
  return session.id;
}

type RuntimeWithInternals = DaemonRuntime & {
  sessions: Map<string, { session: Session; messages: Message[]; turnQueue: Promise<unknown> }>;
  whatsappSessionToSource: Map<string, string>;
};

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

  it("success path: marker + requestRestartAfterTurn, no turn → confirmation sent to channel first, then restart", async () => {
    const runtime = makeRuntime();
    const shutdownSpy = mockShutdown(runtime);
    const sendMock = vi.fn().mockResolvedValue(undefined);
    (
      runtime as unknown as {
        channelPlugins: Map<string, { sendMessage: (t: string, p: unknown) => Promise<void> }>;
      }
    ).channelPlugins.set("whatsapp", { sendMessage: sendMock });
    vi.spyOn(deployModule, "runDeploy").mockResolvedValue({
      ok: true,
      message: "Deploy prepared.",
      gitHead: "newhash123",
    });

    const sessionId = await registerWhatsAppSession(runtime, "491701234567");
    const result = await runtime.handleChannelSlashCommand(sessionId, "/deploy feat/x");
    expect(result).not.toBeNull();
    // No turn running → the confirmation is flushed to the channel and
    // the response slot is empty (nothing left to send via outbound).
    expect(result!.response).toBe("");
    // Confirmation was sent through the channel BEFORE the shutdown.
    expect(sendMock).toHaveBeenCalledWith(
      "491701234567@s.whatsapp.net",
      expect.objectContaining({ text: "Deploy prepared, restarting…" }),
    );
    const marker = await readMarker();
    expect(marker?.reason).toBe("deploy feat/x");
    expect(marker?.gitHead).toBe("newhash123");
    await flushImmediate();
    expect(shutdownSpy).toHaveBeenCalledWith("self-restart", 1);
  });

  it("no turn: pre-restart confirmation send completes before the shutdown signal", async () => {
    const runtime = makeRuntime();
    const shutdownSpy = mockShutdown(runtime);
    // Sends resolve only when explicitly released — proves the restart is
    // NOT scheduled until the deploy ACK and the confirmation message have
    // fully flushed. The ACK is a single awaited send, so a queue that
    // releases one send at a time keeps the handler blocked in order.
    const pending: Array<() => void> = [];
    const sendMock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        }),
    );
    (
      runtime as unknown as {
        channelPlugins: Map<string, { sendMessage: (t: string, p: unknown) => Promise<void> }>;
      }
    ).channelPlugins.set("whatsapp", { sendMessage: sendMock });
    vi.spyOn(deployModule, "runDeploy").mockResolvedValue({
      ok: true,
      message: "Deploy prepared.",
      gitHead: "newhash123",
    });

    const sessionId = await registerWhatsAppSession(runtime, "491701234567");
    const command = runtime.handleChannelSlashCommand(sessionId, "/deploy feat/x");

    // Give the handler a tick to reach the ACK send; the shutdown must
    // still be pending because the ACK has not resolved yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(shutdownSpy).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Release the deploy ACK — only now may the deploy run and the
    // confirmation send start.
    pending.shift()!();
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMock).toHaveBeenCalledTimes(2);

    // Release the confirmation — only now may the restart be scheduled.
    pending.shift()!();
    const result = await command;
    expect(result!.response).toBe("");
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
    // No turn running → confirmation went to the channel (no WhatsApp
    // session registered here, so nothing to send), response slot empty.
    expect(result!.response).toBe("");
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

describe("request_restart tool capability (daemon side)", () => {
  it("schedules a deferred restart with reason + current session as replyTarget, followUp marker", async () => {
    vi.spyOn(selfModifyModule, "currentGitHead").mockResolvedValue("mockhead");
    const runtime = makeRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    const shutdownSpy = mockShutdown(runtime);
    internals.turnActive = true;

    const sessionId = await registerWhatsAppSession(runtime, "491701234567");
    const sendMock = vi.fn().mockResolvedValue(undefined);
    (
      runtime as unknown as {
        channelPlugins: Map<string, { sendMessage: (t: string, p: unknown) => Promise<void> }>;
      }
    ).channelPlugins.set("whatsapp", { sendMessage: sendMock });

    const cap = (runtime as unknown as {
      makeRequestRestartCapability: (sid: string) => (reason: string) => Promise<{ ok: boolean; error?: string }>;
    }).makeRequestRestartCapability(sessionId);

    const result = await cap("new API key added to ~/harness/.env");
    expect(result.ok).toBe(true);
    // Turn still active → no immediate exit.
    expect(shutdownSpy).not.toHaveBeenCalled();

    // The pre-restart announcement is flushed to the channel synchronously,
    // BEFORE the marker is written — user gets immediate feedback.
    expect(sendMock).toHaveBeenCalledWith(
      "491701234567@s.whatsapp.net",
      expect.objectContaining({ text: expect.stringContaining("Restart eingeleitet") }),
    );

    const marker = await readMarker();
    expect(marker?.reason).toBe("new API key added to ~/harness/.env");
    expect(marker?.replyTarget).toBe("491701234567");
    expect(marker?.gitHead).toBe("mockhead");
    expect(marker?.followUp).toBe(true);
  });

  it("rejects with 'already scheduled' when a restart is already pending", async () => {
    vi.spyOn(selfModifyModule, "currentGitHead").mockResolvedValue("mockhead");
    const runtime = makeRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    internals.turnActive = true;
    const sessionId = await registerWhatsAppSession(runtime, "491701234567");
    const cap = (runtime as unknown as {
      makeRequestRestartCapability: (sid: string) => (reason: string) => Promise<{ ok: boolean; error?: string }>;
    }).makeRequestRestartCapability(sessionId);

    // First scheduling succeeds.
    await cap("first reason");
    // Second attempt must be refused — no double scheduling.
    const second = await cap("second reason");
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already scheduled");
  });

  it("rejects with 'already scheduled' while a deploy is in flight", async () => {
    vi.spyOn(selfModifyModule, "currentGitHead").mockResolvedValue("mockhead");
    const runtime = makeRuntime();
    const internals = runtime as unknown as RuntimeInternals & { selfModifyInFlight: boolean };
    internals.selfModifyInFlight = true;
    const sessionId = await registerWhatsAppSession(runtime, "491701234567");
    const cap = (runtime as unknown as {
      makeRequestRestartCapability: (sid: string) => (reason: string) => Promise<{ ok: boolean; error?: string }>;
    }).makeRequestRestartCapability(sessionId);

    const result = await cap("config change");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already scheduled");
  });
});

describe("post-restart follow-up", () => {
  it("boot with followUp marker → runs an agent turn on the reply-target session, no static ping", async () => {
    await writeFile(
      markerFile(),
      JSON.stringify({
        timestamp: "2026-08-08T10:00:00.000Z",
        reason: "new API key",
        replyTarget: "491701234567",
        gitHead: "abc1234",
        followUp: true,
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    internals.agent = createRecordingFakeAgent().agent;
    internals.model = createFakeModel();
    const sessionId = await registerWhatsAppSession(runtime, "491701234567");

    const sendMock = vi.fn().mockResolvedValue(undefined);
    (
      runtime as unknown as {
        channelPlugins: Map<string, { sendMessage: (t: string, p: unknown) => Promise<void> }>;
      }
    ).channelPlugins.set("whatsapp", { sendMessage: sendMock });

    const marker = await selfModifyModule.readPendingRestart();
    expect(marker?.followUp).toBe(true);

    await selfModifyModule.sendRestartPing(
      marker!,
      (t, p) => sendMock(t, p),
      vi.fn(),
      () => (runtime as unknown as { runRestartFollowUp: (sid: string, reason: string) => Promise<void> }).runRestartFollowUp(sessionId, marker!.reason),
    );

    // Follow-up answer routed via the channel plugin, no static ping text.
    expect(sendMock).toHaveBeenCalledWith(
      "491701234567@s.whatsapp.net",
      expect.objectContaining({ text: "Follow-up OK" }),
    );
    expect(sendMock).not.toHaveBeenCalledWith(
      "491701234567@s.whatsapp.net",
      expect.objectContaining({ text: expect.stringContaining("Back online") }),
    );
    // Marker consumed.
    await expect(readFile(markerFile())).rejects.toThrow();
  });

  it("follow-up turn fails → static ping sent as fallback, marker still consumed", async () => {
    await writeFile(
      markerFile(),
      JSON.stringify({
        timestamp: "2026-08-08T10:00:00.000Z",
        reason: "new API key",
        replyTarget: "491701234567",
        gitHead: "abc1234",
        followUp: true,
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

    const marker = await selfModifyModule.readPendingRestart();
    await selfModifyModule.sendRestartPing(
      marker!,
      (t, p) => sendMock(t, p),
      vi.fn(),
      async () => {
        throw new Error("follow-up session not found");
      },
    );

    expect(sendMock).toHaveBeenCalledWith(
      "491701234567@s.whatsapp.net",
      expect.objectContaining({ text: expect.stringContaining("Back online") }),
    );
    await expect(readFile(markerFile())).rejects.toThrow();
  });

  it("marker without followUp → static ping unchanged", async () => {
    await writeFile(
      markerFile(),
      JSON.stringify({
        timestamp: "2026-08-08T10:00:00.000Z",
        reason: "manual /restart",
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

    const marker = await selfModifyModule.readPendingRestart();
    expect(marker?.followUp).toBeUndefined();

    const followUpRunner = vi.fn();
    await selfModifyModule.sendRestartPing(
      marker!,
      (t, p) => sendMock(t, p),
      vi.fn(),
      followUpRunner,
    );

    expect(followUpRunner).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith(
      "491701234567@s.whatsapp.net",
      expect.objectContaining({ text: expect.stringContaining("Back online") }),
    );
    await expect(readFile(markerFile())).rejects.toThrow();
  });

  it("request_restart inside a follow-up turn → error, no second restart", async () => {
    vi.spyOn(selfModifyModule, "currentGitHead").mockResolvedValue("mockhead");
    const runtime = makeRuntime();
    const internals = runtime as unknown as RuntimeInternals & {
      postRestartFollowUpActive: boolean;
      makeRequestRestartCapability: (sid: string) => (reason: string) => Promise<{ ok: boolean; error?: string }>;
    };
    internals.postRestartFollowUpActive = true;
    const sessionId = await registerWhatsAppSession(runtime, "491701234567");

    const cap = internals.makeRequestRestartCapability(sessionId);
    const result = await cap("loop attempt");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("post-restart follow-up");
    // No marker written.
    expect(await readMarker()).toBeNull();
  });
});
