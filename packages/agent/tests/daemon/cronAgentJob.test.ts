import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DaemonRuntime } from "../../src/daemon/runtime.js";
import type {
  IpcRequest,
  IpcResponse,
} from "../../src/daemon/types.js";
import type { CronJob } from "../../src/daemon/jobs.js";

/**
 * Runtime-level test for agent cron jobs: runCronAgentJob must create a
 * new session with origin "cron" and run the job body as its first turn.
 * The agent is stubbed (no LLM), everything else is the real code path.
 */

interface RuntimeInternals {
  agent: unknown;
  model: unknown;
  profiles: Map<
    string,
    {
      name: string;
      frontmatter: {
        name: string;
        model?: { provider: string; model: string };
        thinking?: boolean;
        tools?: string[];
        memory?: string[];
        skills: boolean;
      };
      body: string;
      filePath: string;
      dir: string;
      builtin: boolean;
    }
  >;
  profileAgents: Map<
    string,
    {
      agent: unknown;
      model: { name: string } | null;
      tools: unknown[];
      prompt: string;
      memoryZones: unknown[];
    }
  >;
  handleIpcRequest(req: IpcRequest): Promise<IpcResponse>;
}

const AGENT_JOB: CronJob = {
  name: "daily-report",
  schedule: "0 7 * * *",
  enabled: true,
  type: "agent",
  jitterMs: 0,
  body: "Write the daily report.",
  filePath: "/jobs/daily-report.md",
};

const ORIGINAL_ENV = {
  HARNESS_HOME: process.env.HARNESS_HOME,
  HARNESS_STATE: process.env.HARNESS_STATE,
};

let TEST_DIR: string;

beforeEach(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), "harness-cron-agent-"));
  process.env.HARNESS_HOME = join(TEST_DIR, "home");
  process.env.HARNESS_STATE = join(TEST_DIR, "state");
  await mkdir(process.env.HARNESS_HOME, { recursive: true });
  await mkdir(process.env.HARNESS_STATE, { recursive: true });
});

afterEach(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(TEST_DIR, { recursive: true, force: true });
});

function makeRuntime(): { runtime: DaemonRuntime; internals: RuntimeInternals } {
  const runtime = new DaemonRuntime();
  return { runtime, internals: runtime as unknown as RuntimeInternals };
}

function stubAgent(captured: Array<Array<Record<string, unknown>>>): unknown {
  return {
    run: async (messages: Array<Record<string, unknown>>) => {
      captured.push([...messages]);
      return {
        aborted: false,
        finalMessage: "report done",
        turns: 1,
        completedTurns: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cacheRead: 0,
          cacheWrite: 0,
        },
      };
    },
  };
}

describe("DaemonRuntime.runCronAgentJob", () => {
  it("creates a session with origin cron and runs the body as first turn", async () => {
    const { runtime, internals } = makeRuntime();
    const captured: Array<Array<Record<string, unknown>>> = [];
    internals.agent = stubAgent(captured);
    internals.model = { name: "test-model" };

    const sessionId = await runtime.runCronAgentJob(AGENT_JOB);
    expect(sessionId).toBeTruthy();

    // Body became the first turn's user message
    expect(captured).toHaveLength(1);
    expect(captured[0]![0]).toMatchObject({
      role: "user",
      content: "Write the daily report.",
    });

    // Session is registered with origin "cron" and one completed turn
    const listed = await internals.handleIpcRequest({ type: "list-sessions" });
    if (listed.type !== "sessions-listed") {
      throw new Error(`unexpected response: ${listed.type}`);
    }
    const summary = listed.sessions.find((s) => s.sessionId === sessionId);
    expect(summary).toBeDefined();
    expect(summary!.origin).toBe("cron");
    expect(summary!.turnsCompleted).toBe(1);
    expect(summary!.title).toBe("cron: daily-report");
  });

  it("rejects when the daemon agent is not initialized", async () => {
    const { runtime } = makeRuntime();
    await expect(runtime.runCronAgentJob(AGENT_JOB)).rejects.toThrow(
      /not fully initialized/,
    );
  });
});

describe("DaemonRuntime.runCronAgentJob overload", () => {
  it("runs the session-end agent with the transcript path as input", async () => {
    const { runtime, internals } = makeRuntime();
    const captured: Array<Array<Record<string, unknown>>> = [];
    internals.agent = stubAgent(captured);
    internals.model = { name: "test-model" };
    // Register the session-end profile so create-session accepts it.
    internals.profiles.set("session-end", {
      name: "session-end",
      frontmatter: { name: "session-end", skills: false },
      body: "Persona of session-end.",
      filePath: "/agents/session-end/agent.md",
      dir: "/agents/session-end",
      builtin: true,
    });
    // Warm the session-end profile agent cache — bypasses model resolution.
    internals.profileAgents.set("session-end", {
      agent: stubAgent(captured),
      model: { name: "test-model" },
      tools: [],
      prompt: "session-end prompt",
      memoryZones: [],
    });

    const sessionId = await runtime.runCronAgentJob("session-end", {
      transcript: "/tmp/x/session.jsonl",
    });
    expect(sessionId).toBeTruthy();

    expect(captured).toHaveLength(1);
    const firstMsg = captured[0]![0] as { role: string; content: string };
    expect(firstMsg.role).toBe("user");
    expect(firstMsg.content).toContain("/tmp/x/session.jsonl");
    expect(firstMsg.content).toContain(".protocol.md");
  });

  it("throws when the ad-hoc job input is missing", async () => {
    const { runtime, internals } = makeRuntime();
    internals.agent = stubAgent([]);
    internals.model = { name: "test-model" };

    // @ts-expect-error — missing input on purpose
    await expect(runtime.runCronAgentJob("session-end")).rejects.toThrow(
      /requires an input object/,
    );
  });
});

describe("session-end hook after end-session", () => {
  it("starts the session-end agent after a session ends (fire-and-forget)", async () => {
    const { runtime, internals } = makeRuntime();
    internals.agent = stubAgent([]);
    internals.model = { name: "test-model" };
    // Register + warm the session-end profile.
    internals.profiles.set("session-end", {
      name: "session-end",
      frontmatter: { name: "session-end", skills: false },
      body: "Persona of session-end.",
      filePath: "/agents/session-end/agent.md",
      dir: "/agents/session-end",
      builtin: true,
    });

    // The session-end stub resolves a promise on first run so we can
    // await the fire-and-forget trigger.
    let resolveRun: (() => void) | undefined;
    const ran = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const sessionEndCaptured: Array<Array<Record<string, unknown>>> = [];
    const sessionEndStub = {
      run: async (messages: Array<Record<string, unknown>>) => {
        sessionEndCaptured.push([...messages]);
        resolveRun?.();
        return {
          aborted: false,
          finalMessage: "protocol written",
          turns: 1,
          completedTurns: 1,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            cacheRead: 0,
            cacheWrite: 0,
          },
        };
      },
    };
    internals.profileAgents.set("session-end", {
      agent: sessionEndStub,
      model: { name: "test-model" },
      tools: [],
      prompt: "session-end prompt",
      memoryZones: [],
    });

    // Create a session, then end it via IPC — the hook must fire.
    const created = await internals.handleIpcRequest({
      type: "create-session",
    });
    if (created.type !== "session-created") throw new Error("session not created");

    const ended = await internals.handleIpcRequest({
      type: "end-session",
      sessionId: created.sessionId,
    });
    expect(ended.type).toBe("session-ended");

    await ran;
    expect(sessionEndCaptured).toHaveLength(1);
    const firstMsg = sessionEndCaptured[0]![0] as { role: string; content: string };
    expect(firstMsg.role).toBe("user");
    expect(firstMsg.content).toContain(".jsonl");
    expect(firstMsg.content).toContain(".protocol.md");
  });
});
