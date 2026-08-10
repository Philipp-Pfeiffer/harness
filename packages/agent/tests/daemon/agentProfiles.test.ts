import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveModel, type AgentProfile, type Tool } from "@harness/core";
import { DaemonRuntime } from "../../src/daemon/runtime.js";
import type { IpcRequest, IpcResponse } from "../../src/daemon/types.js";
import type { CronJob } from "../../src/daemon/jobs.js";

/**
 * Runtime-level tests for agent profiles: create-session with a profile
 * must produce a session whose agent has the profile's prompt, model and
 * tool subset. Unknown profiles fail with a clean error. Sessions without
 * a profile behave exactly like before (shared default agent).
 */

interface ProfileAgentCtx {
  agent: unknown;
  model: { name: string } | null;
  tools: Tool[];
  prompt: string;
  memoryZones: string[];
  cwd: string | null;
}

interface SessionEntryInternals {
  profile: string;
}

interface RuntimeInternals {
  agent: unknown;
  model: unknown;
  profiles: Map<string, AgentProfile>;
  profileAgents: Map<string, ProfileAgentCtx>;
  configModels: Array<{
    provider: string;
    model: string;
    alias?: string;
    baseUrl?: string;
    apiKey?: string;
  }>;
  allTools: Tool[];
  defaultTools: Tool[];
  basePrompt: string;
  hotSetBlock: string;
  coreMemoryRaw: string | undefined;
  defaultPrompt: string;
  sessions: Map<string, SessionEntryInternals>;
  handleIpcRequest(req: IpcRequest): Promise<IpcResponse>;
}

const ORIGINAL_ENV = {
  HARNESS_HOME: process.env.HARNESS_HOME,
  HARNESS_STATE: process.env.HARNESS_STATE,
};

let TEST_DIR: string;

beforeEach(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), "harness-agent-profiles-"));
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

function fakeTool(name: string): Tool {
  return { name } as unknown as Tool;
}

function makeProfile(partial: {
  name: string;
  body?: string;
  frontmatter?: Partial<AgentProfile["frontmatter"]>;
}): AgentProfile {
  return {
    name: partial.name,
    frontmatter: {
      name: partial.name,
      skills: true,
      ...partial.frontmatter,
    },
    body: partial.body ?? `Persona of ${partial.name}.`,
    filePath: `/agents/${partial.name}/agent.md`,
    dir: `/agents/${partial.name}`,
    builtin: true,
  };
}

function stubAgent(captured: Array<Array<Record<string, unknown>>>): unknown {
  return {
    run: async (messages: Array<Record<string, unknown>>) => {
      captured.push([...messages]);
      return {
        aborted: false,
        finalMessage: "done",
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
    setSystemPrompt: () => {},
    setModel: () => {},
  };
}

/**
 * Builds a runtime with a stubbed default agent and a "worker" profile.
 * Mirrors how initAgent() populates the profile-related fields, without
 * starting the daemon.
 */
function makeRuntime(profiles: AgentProfile[] = []): {
  runtime: DaemonRuntime;
  internals: RuntimeInternals;
  captured: Array<Array<Record<string, unknown>>>;
} {
  const runtime = new DaemonRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  const captured: Array<Array<Record<string, unknown>>> = [];

  internals.agent = stubAgent(captured);
  internals.model = { name: "test-model" };
  internals.allTools = [
    fakeTool("readFile"),
    fakeTool("exec"),
    fakeTool("write"),
    fakeTool("search_memory"),
    fakeTool("web_fetch"),
  ];
  internals.defaultTools = internals.allTools;
  internals.basePrompt = "BASE PROMPT";
  internals.hotSetBlock = "HOTSET BLOCK";
  internals.coreMemoryRaw = "CORE MEMORY";
  internals.defaultPrompt = "DEFAULT COMPOSED PROMPT";
  internals.profiles = new Map(profiles.map((p) => [p.name, p]));

  return { runtime, internals, captured };
}

describe("create-session with agent profiles", () => {
  it("rejects an unknown profile with a clean error", async () => {
    const { runtime, internals } = makeRuntime([makeProfile({ name: "worker" })]);

    const resp = await internals.handleIpcRequest({
      type: "create-session",
      profile: "ghost",
    });

    expect(resp.type).toBe("error");
    if (resp.type === "error") {
      expect(resp.message).toContain('Unknown agent profile "ghost"');
      expect(resp.message).toContain("worker");
    }
    void runtime;
  });

  it("creates a session whose agent has the profile's prompt and tool subset", async () => {
    const worker = makeProfile({
      name: "worker",
      body: "WORKER PERSONA",
      frontmatter: {
        tools: ["readFile", "search_memory"],
        memory: ["notes"],
        skills: false,
      },
    });
    const { internals } = makeRuntime([worker]);

    const resp = await internals.handleIpcRequest({
      type: "create-session",
      profile: "worker",
    });

    expect(resp.type).toBe("session-created");
    if (resp.type !== "session-created") return;
    expect(resp.profile).toBe("worker");

    const ctx = internals.profileAgents.get("worker");
    expect(ctx).toBeDefined();

    // Tool subset: allowlist applied, search_memory kept (notes zone granted)
    expect(ctx!.tools.map((t) => t.name)).toEqual(["readFile", "search_memory"]);

    // Prompt: bare base + persona; no hot-set (skills: false); no core memory (zone not granted)
    expect(ctx!.prompt).toContain("BASE PROMPT");
    expect(ctx!.prompt).toContain("WORKER PERSONA");
    expect(ctx!.prompt).not.toContain("HOTSET BLOCK");
    expect(ctx!.prompt).not.toContain("core_memory");

    // Session runs under the profile
    const entry = internals.sessions.get(resp.sessionId);
    expect(entry!.profile).toBe("worker");
  });

  it("removes search_memory when the notes zone is not granted, even if allowlisted", async () => {
    const noMemory = makeProfile({
      name: "worker",
      frontmatter: { tools: ["readFile", "search_memory"], memory: [] },
    });
    const { internals } = makeRuntime([noMemory]);

    const resp = await internals.handleIpcRequest({
      type: "create-session",
      profile: "worker",
    });
    expect(resp.type).toBe("session-created");

    const ctx = internals.profileAgents.get("worker");
    expect(ctx!.tools.map((t) => t.name)).toEqual(["readFile"]);
    expect(ctx!.memoryZones).toEqual([]);
  });

  it("resolves the profile's model override for the session", async () => {
    const expected = resolveModel("minimax", "MiniMax-M2.7");
    const withModel = makeProfile({
      name: "worker",
      frontmatter: { model: { provider: "minimax", model: "MiniMax-M2.7" } },
    });
    const { internals } = makeRuntime([withModel]);

    const resp = await internals.handleIpcRequest({
      type: "create-session",
      profile: "worker",
    });
    expect(resp.type).toBe("session-created");
    if (resp.type !== "session-created") return;

    const ctx = internals.profileAgents.get("worker");
    expect(ctx!.model?.name).toBe(expected.name);

    const listed = await internals.handleIpcRequest({ type: "list-sessions" });
    if (listed.type !== "sessions-listed") throw new Error("unexpected response");
    expect(listed.sessions.find((s) => s.sessionId === resp.sessionId)!.model).toBe(expected.name);
  });

  it("returns a clean error when the profile's model cannot be resolved", async () => {
    const broken = makeProfile({
      name: "worker",
      frontmatter: { model: { provider: "no-such-provider", model: "x" } },
    });
    const { internals } = makeRuntime([broken]);

    const resp = await internals.handleIpcRequest({
      type: "create-session",
      profile: "worker",
    });
    expect(resp.type).toBe("error");
    if (resp.type === "error") {
      expect(resp.message).toContain("no-such-provider");
    }
  });

  it("resolves a @preset profile model via configModels", async () => {
    const preset = makeProfile({
      name: "worker",
      frontmatter: {
        model: { provider: "@preset", model: "deepseek-flash" },
      },
    });
    const { internals } = makeRuntime([preset]);
    internals.configModels = [
      {
        provider: "openrouter",
        model: "@preset/deepseek-flash",
        alias: "DeepSeek Flash",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-test",
      },
    ];
    internals.model = { name: "fallback-model" };

    const resp = await internals.handleIpcRequest({
      type: "create-session",
      profile: "worker",
    });
    expect(resp.type).toBe("session-created");
    if (resp.type !== "session-created") return;

    // The profile agent was created with the config preset, not a
    // "Unknown provider '@preset'" error from plain resolveModel.
    const ctx = internals.profileAgents.get("worker");
    expect(ctx).toBeDefined();
    expect(ctx!.model?.name).toBe("DeepSeek Flash");
  });

  it("runs turns of a profile session on the profile's agent", async () => {
    const worker = makeProfile({ name: "worker", body: "WORKER PERSONA" });
    const { internals, captured } = makeRuntime([worker]);

    const created = await internals.handleIpcRequest({
      type: "create-session",
      profile: "worker",
    });
    if (created.type !== "session-created") throw new Error("session not created");

    // Swap the real profile agent for a stub that captures messages.
    const profileCaptured: Array<Array<Record<string, unknown>>> = [];
    internals.profileAgents.get("worker")!.agent = stubAgent(profileCaptured);

    const resp = await internals.handleIpcRequest({
      type: "submit-turn",
      text: "hello worker",
      sessionId: created.sessionId,
    });
    expect(resp.type).toBe("turn-complete");

    // The profile agent ran the turn, not the shared default agent.
    expect(profileCaptured).toHaveLength(1);
    expect(profileCaptured[0]![0]).toMatchObject({ role: "user", content: "hello worker" });
    expect(captured).toHaveLength(0);
  });
});

describe("default behavior without profile", () => {
  it("treats a missing profile parameter exactly like the explicit default profile", async () => {
    const { internals, captured } = makeRuntime();

    const implicit = await internals.handleIpcRequest({ type: "create-session" });
    expect(implicit.type).toBe("session-created");
    if (implicit.type !== "session-created") return;
    expect(implicit.profile).toBe("default");
    expect(internals.sessions.get(implicit.sessionId)!.profile).toBe("default");

    const explicit = await internals.handleIpcRequest({
      type: "create-session",
      profile: "default",
    });
    expect(explicit.type).toBe("session-created");
    if (explicit.type !== "session-created") return;
    expect(explicit.profile).toBe("default");

    // Both sessions run on the shared default agent.
    await internals.handleIpcRequest({
      type: "submit-turn",
      text: "hi",
      sessionId: implicit.sessionId,
    });
    await internals.handleIpcRequest({
      type: "submit-turn",
      text: "hi",
      sessionId: explicit.sessionId,
    });
    expect(captured).toHaveLength(2);
  });

  it("persists the profile on the session so resume restores it", async () => {
    const worker = makeProfile({ name: "worker" });
    const { internals } = makeRuntime([worker]);

    const created = await internals.handleIpcRequest({
      type: "create-session",
      profile: "worker",
    });
    if (created.type !== "session-created") throw new Error("session not created");

    const indexRaw = await readFile(
      join(process.env.HARNESS_STATE!, "sessions", "sessions.json"),
      "utf-8",
    );
    const index = JSON.parse(indexRaw) as Array<{ sessionId: string; profile?: string }>;
    expect(index.find((e) => e.sessionId === created.sessionId)!.profile).toBe("worker");
  });
});

describe("cron jobs with agent field", () => {
  const AGENT_JOB: CronJob = {
    name: "distill-daily",
    schedule: "0 7 * * *",
    enabled: true,
    type: "agent",
    jitterMs: 0,
    agent: "worker",
    body: "Distill today's notes.",
    filePath: "/jobs/distill-daily.md",
  };

  it("creates the cron session under the job's profile", async () => {
    const worker = makeProfile({ name: "worker", body: "WORKER PERSONA" });
    const { runtime, internals } = makeRuntime([worker]);

    // Warm the profile agent cache and stub it (runCronAgentJob runs a full turn).
    const warm = await internals.handleIpcRequest({
      type: "create-session",
      profile: "worker",
    });
    expect(warm.type).toBe("session-created");
    const profileCaptured: Array<Array<Record<string, unknown>>> = [];
    internals.profileAgents.get("worker")!.agent = stubAgent(profileCaptured);

    const sessionId = await runtime.runCronAgentJob(AGENT_JOB);
    expect(sessionId).toBeTruthy();

    // The job body ran as the first turn on the profile's agent.
    expect(profileCaptured).toHaveLength(1);
    expect(profileCaptured[0]![0]).toMatchObject({
      role: "user",
      content: "Distill today's notes.",
    });

    // The cron session is registered under the job's profile.
    expect(internals.sessions.get(sessionId)!.profile).toBe("worker");
  });

  it("fails cleanly when the job's profile is unknown", async () => {
    const { runtime } = makeRuntime();
    await expect(runtime.runCronAgentJob(AGENT_JOB)).rejects.toThrow(
      /Unknown agent profile "worker"/,
    );
  });
});
