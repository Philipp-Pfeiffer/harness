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
