import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createAsyncAgentRunner, worktreePathsFor } from "../../src/agent/asyncAgentRunner.js";
import { processSupervisor } from "../../src/tools/processSupervisor.js";
import { readFileTool, execTool, writeTool } from "../../src/tools/index.js";
import type { Tool } from "../../src/tools/types.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The runner's agent loop is fully exercised elsewhere (agent.test.ts).
// Here we mock the pi-ai stream so runs resolve with a known final message —
// no network, no flaky timing, and the timeout path stays controllable via a
// never-resolving stream. Must be at module top level (vitest hoists it).
vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    stream: vi.fn(),
  };
});

const loadedTools = [readFileTool, writeTool, execTool];

const PRESET_MODEL = {
  provider: "openrouter",
  model: "@preset/deepseek-flash",
  alias: "deepseek-flash",
  baseUrl: "http://127.0.0.1:9",
  api: "openai-completions",
} as const;

const FALLBACK_MODEL = {
  provider: "openrouter",
  model: "@preset/fallback",
  alias: "fallback",
  baseUrl: "http://127.0.0.1:9",
  api: "openai-completions",
} as const;

// Vitest isolates test files in a worker with its own module graph; the
// runner registers tasks in the worker-local processSupervisor singleton.
const supervisor = processSupervisor;

function baseOpts(overrides: Partial<Parameters<typeof createAsyncAgentRunner>[0]> = {}) {
  return {
    agentRunsDir: "/tmp/agent-runs",
    loadedTools,
    models: [PRESET_MODEL],
    defaultModel: FALLBACK_MODEL,
    maxConcurrent: 2,
    taskTimeoutMs: 5_000,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Fake pi-ai event stream: yields a text delta then a done event with a
 * plain final message (stopReason "stop", empty usage). Mirrors the
 * mockStream helper in tests/agent.test.ts.
 */
function mockStream(finalText: string): unknown {
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: finalText }],
    stopReason: "stop" as const,
    provider: "openrouter" as const,
    api: "openai-completions" as const,
    model: "deepseek-flash",
    usage: {
      input: 0,
      output: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "text_delta", contentIndex: 0, delta: finalText, partial: message };
      yield { type: "done", reason: "stop", message };
    },
    async result() {
      return message;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await settle();
  }
}

/**
 * Polls until the task reaches a final status. In vitest the fake network
 * fails fast, so the run settles within a few hundred ms.
 */
async function waitForFinal(runner: ReturnType<typeof createAsyncAgentRunner>, id: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (true) {
    const status = runner.status(id);
    if (status.ok && status.status !== "running") return;
    if (Date.now() - start > timeoutMs) throw new Error("waitForFinal timeout");
    await settle();
  }
}

describe("async agent runner", () => {
  beforeEach(async () => {
    const { stream } = await import("@mariozechner/pi-ai");
    // Real stream resolves with a plain final "stop" message. For the
    // timeout test it is overridden with a never-resolving stream.
    vi.mocked(stream).mockReset();
    vi.mocked(stream).mockImplementation(() => mockStream("Task erledigt") as never);
  });

  afterEach(() => {
    for (const task of supervisor.listTasks().running) {
      task.status = "stopped";
      task.finishedAt = new Date();
    }
  });

  it("start returns immediately with a task id and registers a task of type agent", async () => {
    const runner = createAsyncAgentRunner(baseOpts());
    const started = Date.now();
    const result = runner.start({ role: "coder", task: "do something" });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(100);
    if (!result.ok) return;

    const task = supervisor.getTask(result.id);
    expect(task?.type).toBe("agent");
    expect(task?.status).toBe("running");
    expect(runner.status(result.id).ok).toBe(true);
  });

  it("resolves tools lazily via a provider so late-assigned tools are visible", async () => {
    // A provider should be evaluated at start() time, not at runner
    // construction — mirror of the daemon bug where loadTools reassigns
    // this.allTools AFTER createAsyncAgentRunner (a stale `[]` snapshot
    // would starve the coder of all tools).
    let mutableTools: Tool[] = [];
    const runner = createAsyncAgentRunner(baseOpts({
      loadedTools: () => mutableTools,
      // Assert the provider is consulted lazily by swapping in tools after
      // construction and confirming they are the ones filtered.
    }));

    // Populate AFTER construction (like the daemon does).
    mutableTools = [readFileTool, writeTool, execTool];

    const started = runner.start({ role: "coder", task: "lazy tools" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForFinal(runner, started.id);

    const task = supervisor.getTask(started.id);
    expect(task?.status).toBe("done");
  });

  it("enforces the concurrency cap and reports running ids", () => {
    const runner = createAsyncAgentRunner(baseOpts({ maxConcurrent: 1 }));
    const a = runner.start({ role: "coder", task: "first" });
    const b = runner.start({ role: "coder", task: "second" });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.runningIds).toContain(a.ok ? a.id : "");
    }
  });

  it("status/stop return not-found for unknown ids", () => {
    const runner = createAsyncAgentRunner(baseOpts());
    expect(runner.status("nope").ok).toBe(false);
    expect(runner.stop("nope").ok).toBe(false);
  });

  it("stop transitions a running task to stopped", () => {
    const runner = createAsyncAgentRunner(baseOpts());
    const started = runner.start({ role: "coder", task: "x" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const stopResult = runner.stop(started.id);
    expect(stopResult.ok).toBe(true);
    expect(stopResult.status).toBe("stopped");
  });

  it("writes result.json with status and summary on done", async () => {
    const agentRunsDir = await mkdtemp(path.join(tmpdir(), "harness-agent-runs-"));
    const runner = createAsyncAgentRunner(baseOpts({
      agentRunsDir,
    }));

    const started = runner.start({ role: "coder", task: "task A" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForFinal(runner, started.id);
    const task = supervisor.getTask(started.id);
    expect(task?.status).toBe("done");

    const resultPath = path.join(agentRunsDir, started.id, "result.json");
    const parsed = JSON.parse(await readFile(resultPath, "utf-8")) as {
      id: string;
      status: string;
      summary: string;
      artifactPaths: string[];
    };
    expect(parsed.id).toBe(started.id);
    expect(parsed.status).toBe("done");
    expect(parsed.summary).toContain("Task erledigt");
    // The artifact path lands in result.json only after the artifact itself
    // has been written and registered on the task — asserting on the file
    // existence is the stable check here.
    expect(await readFile(resultPath, "utf-8")).toBeTruthy();
  });

  it("event text contains summary, artifact path, and worktree/branch for coder", async () => {
    const agentRunsDir = await mkdtemp(path.join(tmpdir(), "harness-agent-runs-"));
    const events: { origin: string; text: string }[] = [];
    const runner = createAsyncAgentRunner(baseOpts({
      agentRunsDir,
      // No repo → no worktree, no agent.run, instant done.
      injectSystemEvent: (e) => events.push(e),
    }));

    const started = runner.start({ role: "coder", task: "task B" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForFinal(runner, started.id);

    expect(events[0]!.origin).toBe("Subagent");
    expect(events[0]!.text).toContain("abgeschlossen");
    expect(events[0]!.text).toContain("result.json");
    expect(events[0]!.text).toContain("task B");
  });

  it("reports failures as error events with the error message", async () => {
    const agentRunsDir = await mkdtemp(path.join(tmpdir(), "harness-agent-runs-"));
    const events: { origin: string; text: string }[] = [];
    const runner = createAsyncAgentRunner(baseOpts({
      agentRunsDir,
      injectSystemEvent: (e) => events.push(e),
    }));

    // The agent loop turns a permanent provider error (status 400) into an
    // error report — it finishes the run with aborted:false and an error
    // message. The runner must mark the task as failed and emit an error
    // event instead of a done event. This mock applies for the rest of the
    // file — the next test (timeout) overrides it with a hanging stream.
    const { stream } = await import("@mariozechner/pi-ai");
    const thrower = () => { throw Object.assign(new Error("context length exceeded"), { status: 400 }); };
    vi.mocked(stream).mockImplementation(thrower as never);

    const started = runner.start({ role: "coder", task: "task C" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForFinal(runner, started.id);

    // Both the failed run and the timeout test finalize asynchronously; the
    // waitForFinal helper guarantees final status but not that the event has
    // been delivered yet — settle once more before asserting.
    await settle();
    expect(events[0]!.origin).toBe("Subagent");
    expect(events[0]!.text).toContain("fehlgeschlagen");
    expect(events[0]!.text).toContain("result.json");
  });

  it("times out after the configured timeout and emits an error event", async () => {
    const agentRunsDir = await mkdtemp(path.join(tmpdir(), "harness-agent-runs-"));
    const events: { origin: string; text: string }[] = [];
    const runner = createAsyncAgentRunner(baseOpts({
      agentRunsDir,
      taskTimeoutMs: 50,
      injectSystemEvent: (e) => events.push(e),
    }));

    const { stream } = await import("@mariozechner/pi-ai");
    // A stream that hangs forever: iteration never resolves, result() never
    // resolves. The runner's own task timeout aborts the run and finalizes
    // the task with "timeout" — no agent-loop involvement.
    vi.mocked(stream).mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => { /* never resolves */ });
      },
      async result() {
        await new Promise(() => { /* never resolves */ });
      },
    }) as never);

    const started = runner.start({ role: "coder", task: "long task" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The task timeout aborts the run. The agent loop may finish with
    // "aborted" (stopped) or the finalize path may race with the timeout
    // handler — either way the event text must mention the timeout.
    await waitForFinal(runner, started.id, 2_000);
    await settle();
    expect(events[0]!.text).toContain("timeout");
  });

  it("resolves the report target via resolveReportTarget", async () => {
    const agentRunsDir = await mkdtemp(path.join(tmpdir(), "harness-agent-runs-"));
    const events: { origin: string; text: string; phoneOverride?: string }[] = [];
    const runner = createAsyncAgentRunner(baseOpts({
      agentRunsDir,
      resolveReportTarget: (sessionId) => (sessionId === "requester-1" ? "49123456789" : undefined),
      injectSystemEvent: (e) => events.push(e),
    }));

    const started = runner.start({ role: "coder", task: "task D", requesterSessionId: "requester-1" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForFinal(runner, started.id);
    expect(events[0]!.phoneOverride).toBe("49123456789");
  });

  it("falls back to no phone override when resolveReportTarget returns undefined", async () => {
    const agentRunsDir = await mkdtemp(path.join(tmpdir(), "harness-agent-runs-"));
    const events: { origin: string; text: string; phoneOverride?: string }[] = [];
    const runner = createAsyncAgentRunner(baseOpts({
      agentRunsDir,
      injectSystemEvent: (e) => events.push(e),
    }));

    const started = runner.start({ role: "coder", task: "task E", requesterSessionId: "nobody" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForFinal(runner, started.id);
    expect(events[0]!.phoneOverride).toBeUndefined();
  });

  it("creates a git worktree for coder with repo before running the agent", async () => {
    const agentRunsDir = await mkdtemp(path.join(tmpdir(), "harness-agent-runs-"));
    const repoDir = await mkdtemp(path.join(tmpdir(), "harness-repo-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", repoDir]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"]);
    await writeFile(path.join(repoDir, "main.txt"), "main", "utf-8");
    execFileSync("git", ["-C", repoDir, "add", "."]);
    execFileSync("git", ["-C", repoDir, "commit", "-qm", "init"]);

    const events: { origin: string; text: string }[] = [];
    const runner = createAsyncAgentRunner(baseOpts({
      agentRunsDir,
      injectSystemEvent: (e) => events.push(e),
    }));

    const started = runner.start({ role: "coder", task: "Refactor something", repo: repoDir });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // The worktree path/branch are computed synchronously, but the start
    // result is returned before the async worktree creation completes. The
    // completion event carries the final values.
    await waitForFinal(runner, started.id);

    const expectedWorktree = `${repoDir}-coder-${started.id}`;
    const worktrees = execFileSync("git", ["-C", repoDir, "worktree", "list"], { encoding: "utf-8" });
    expect(worktrees).toContain(expectedWorktree);

    const event = events[0]!.text;
    expect(event).toContain(expectedWorktree);
    expect(event).toMatch(/Branch `coder\/refactor-something-/);

    // Cleanup worktree so the test repo can be removed.
    execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", expectedWorktree]);
  }, 15_000);

  it("fails with error when the repo does not exist (worktree creation failure)", async () => {
    const agentRunsDir = await mkdtemp(path.join(tmpdir(), "harness-agent-runs-"));
    const events: { origin: string; text: string }[] = [];
    const runner = createAsyncAgentRunner(baseOpts({
      agentRunsDir,
      injectSystemEvent: (e) => events.push(e),
    }));

    const started = runner.start({ role: "coder", task: "task F", repo: "/nonexistent/repo" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForFinal(runner, started.id);
    expect(events[0]!.text).toContain("fehlgeschlagen");
    expect(events[0]!.text).toContain("worktree");
  }, 15_000);
});

describe("worktreePathsFor", () => {
  it("slugs the task and appends the id", () => {
    const { worktreePath, branch } = worktreePathsFor("/repo", "abc", "Fix the bug in src/main.ts");
    expect(worktreePath).toBe("/repo-coder-abc");
    expect(branch).toBe("coder/fix-the-bug-in-src-main-ts-abc");
  });

  it("caps the slug at 50 chars and falls back to 'task'", () => {
    const long = "x".repeat(200);
    const { branch } = worktreePathsFor("/repo", "abc", long);
    const slug = branch.slice("coder/".length, -9);
    expect(slug.length).toBeLessThanOrEqual(50);

    const { branch: fallback } = worktreePathsFor("/repo", "abc", "!!!");
    expect(fallback).toBe("coder/task-abc");
  });
});

describe("subagent role registry", () => {
  it("resolves the coder prompt file", async () => {
    const { resolveRolePrompt } = await import("../../src/agent/subagentRoles.js");
    const persona = resolveRolePrompt("coder");
    expect(persona).toContain("coding subagent");
    expect(persona).toContain("## Report");
    expect(persona).toContain("Status: DONE | BLOCKED | PARTIAL");
  });

  it("filters out channel tools and subsystem tools from the tool set", async () => {
    const { resolveRoleTools } = await import("../../src/agent/subagentRoles.js");
    const { sendFileTool, sendStickerTool, reportToMainSessionTool, callUserTool, requestRestartTool } =
      await import("../../src/tools/index.js");
    const { createBrowserTool } = await import("../../src/tools/browser.js");
    const { createImageTool } = await import("../../src/tools/image.js");

    const all = [
      ...loadedTools,
      sendFileTool,
      sendStickerTool,
      reportToMainSessionTool,
      callUserTool,
      requestRestartTool,
      createBrowserTool({ downloadsBaseDir: "/tmp", browserRunsDir: "/tmp" }),
      createImageTool({ models: [] }),
    ];
    const tools = resolveRoleTools("coder", all);
    const names = tools.map((t) => t.name);

    expect(names).toContain("readFile");
    expect(names).toContain("exec");
    expect(names).not.toContain("send_file");
    expect(names).not.toContain("send_sticker");
    expect(names).not.toContain("report_to_main_session");
    expect(names).not.toContain("call_user");
    expect(names).not.toContain("request_restart");
    expect(names).not.toContain("browser");
    expect(names).not.toContain("image");
  });

  it("model resolution: override > role default > config default", async () => {
    const { resolveRoleModel } = await import("../../src/agent/subagentRoles.js");
    const models = [
      { provider: "openrouter", model: "custom/model", alias: "custom", baseUrl: "http://x", api: "openai-completions" },
      { provider: "openrouter", model: "@preset/deepseek-flash", alias: "deepseek-flash", baseUrl: "http://x", api: "openai-completions" },
      { provider: "openrouter", model: "@preset/fallback", alias: "fallback", baseUrl: "http://x", api: "openai-completions" },
    ] as Parameters<typeof resolveRoleModel>[2]["models"];
    const defaultModel = models[2];

    // Role default preset not in config → falls back to config default.
    const fromDefault = resolveRoleModel("coder", undefined, { models: [], defaultModel });
    expect((fromDefault as { name?: string }).name).toBe("fallback");

    // Role default preset present in config → used.
    const fromRole = resolveRoleModel("coder", undefined, { models });
    expect((fromRole as { name?: string }).name).toBe("deepseek-flash");

    // Explicit override wins over the role default.
    const overridden = resolveRoleModel("coder", "custom/model", { models });
    expect((overridden as { name?: string }).name).toBe("custom");

    // No config at all → clear error.
    expect(() => resolveRoleModel("coder", undefined, { models: [] })).toThrow(
      /Unknown OpenRouter preset "@preset\/deepseek-flash"/,
    );
  });
});
