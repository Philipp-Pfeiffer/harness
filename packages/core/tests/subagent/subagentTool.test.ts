import { describe, it, expect } from "vitest";
import { subagentTool } from "../../src/tools/subagent.js";
import type { SubagentRunner } from "../../src/tools/types.js";
import { processSupervisor } from "../../src/tools/processSupervisor.js";

function makeRunner(overrides: Partial<SubagentRunner> = {}): SubagentRunner {
  return {
    start: () => ({ ok: true, id: "task-1", worktree: "/wt", branch: "coder/x" }),
    status: () => ({ ok: true, status: "done", text: "done text" }),
    stop: () => ({ ok: true, status: "stopped", text: "stopped text" }),
    ...overrides,
  };
}

describe("subagent tool", () => {
  it("returns an error without a runner (capability gate)", async () => {
    const result = await subagentTool.execute(
      { action: "start", role: "coder", task: "fix it" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Kein Subagent-Runner");
  });

  it("dispatches start and returns the id immediately", async () => {
    const runner = makeRunner();
    const result = await subagentTool.execute(
      { action: "start", role: "coder", task: "Fix the bug — run pnpm test, fertig wenn grün", repo: "/repo" },
      { subagentRunner: runner },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("task-1");
    expect(result.content).toContain("/wt");
    expect(result.content).toContain("coder/x");
  });

  it("requires a task for start", async () => {
    const result = await subagentTool.execute(
      { action: "start", role: "coder" },
      { subagentRunner: makeRunner() },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("task ist für action 'start' erforderlich");
  });

  it("relays a start failure including running ids", async () => {
    const runner = makeRunner({
      start: () => ({ ok: false, error: "Max 2 concurrent", runningIds: ["a"] }),
    });
    const result = await subagentTool.execute(
      { action: "start", role: "coder", task: "Fix the bug — run pnpm test, fertig wenn grün" },
      { subagentRunner: runner },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Max 2 concurrent");
  });

  it("dispatches status with the handle", async () => {
    const runner = makeRunner({
      status: () => ({ ok: true, status: "running", text: "still running" }),
    });
    const result = await subagentTool.execute(
      { action: "status", role: "coder", handle: "task-1" },
      { subagentRunner: runner },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("still running");
  });

  it("requires a handle for status/stop", async () => {
    const statusResult = await subagentTool.execute(
      { action: "status", role: "coder" },
      { subagentRunner: makeRunner() },
    );
    expect(statusResult.isError).toBe(true);
    expect(statusResult.content).toContain("handle ist für action 'status' erforderlich");

    const stopResult = await subagentTool.execute(
      { action: "stop", role: "coder" },
      { subagentRunner: makeRunner() },
    );
    expect(stopResult.isError).toBe(true);
    expect(stopResult.content).toContain("handle ist für action 'stop' erforderlich");
  });

  it("dispatches stop", async () => {
    const result = await subagentTool.execute(
      { action: "stop", role: "coder", handle: "task-1" },
      { subagentRunner: makeRunner() },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("stopped text");
  });

  it("passes the requesting session id to start", async () => {
    let received: unknown;
    const runner = makeRunner({
      start: (input) => {
        received = input;
        return { ok: true, id: "task-2" };
      },
    });
    await subagentTool.execute(
      { action: "start", role: "coder", task: "Fix the bug — run pnpm test, fertig wenn grün" },
      { subagentRunner: runner, sessionId: "session-9" },
    );
    expect(received).toMatchObject({ role: "coder", task: "Fix the bug — run pnpm test, fertig wenn grün", requesterSessionId: "session-9" });
  });

  it("rejects a relative repo path (fail-closed) without calling the runner", async () => {
    let called = false;
    const runner = makeRunner({
      start: () => {
        called = true;
        return { ok: true, id: "should-not-start" };
      },
    });
    const result = await subagentTool.execute(
      { action: "start", role: "coder", task: "Fix the bug — run tests, fertig wenn grün", repo: "relative/repo" },
      { subagentRunner: runner },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("absoluter Pfad");
    expect(called).toBe(false);
  });

  it("rejects a ~ path (fail-closed) without calling the runner", async () => {
    let called = false;
    const runner = makeRunner({
      start: () => {
        called = true;
        return { ok: true, id: "should-not-start" };
      },
    });
    const result = await subagentTool.execute(
      { action: "start", role: "coder", task: "Fix the bug — run tests, fertig wenn grün", repo: "~/repos/harness" },
      { subagentRunner: runner },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("absoluter Pfad");
    expect(called).toBe(false);
  });

  it("rejects a task briefing without a done criterion (fail-closed)", async () => {
    const runner = makeRunner({
      start: () => ({ ok: true, id: "should-not-start" }),
    });
    const result = await subagentTool.execute(
      { action: "start", role: "coder", task: "Fix the bug in src/main.ts and run the tests" },
      { subagentRunner: runner },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Done-Kriterium");
  });

  it("accepts an absolute repo path with verification + done criterion", async () => {
    const runner = makeRunner();
    const result = await subagentTool.execute(
      {
        action: "start",
        role: "coder",
        task: "Fix the bug in src/main.ts — run pnpm test, fertig wenn alle Tests grün sind",
        repo: "/home/user/harness",
      },
      { subagentRunner: runner },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("task-1");
  });

  it("warns (not blocks) when an overlapping running task exists in the same repo", async () => {
    const runner = makeRunner();
    const runningTask = {
      id: "existing-1",
      type: "agent" as const,
      status: "running" as const,
      summary: "Fix the bug in src/main.ts — run pnpm test, fertig wenn grün",
      artifactPaths: [],
      startedAt: new Date(),
      stop: () => {},
    };
    processSupervisor.registerTask(runningTask);

    const result = await subagentTool.execute(
      {
        action: "start",
        role: "coder",
        task: "Fix the bug in src/main.ts — run pnpm test, fertig wenn grün",
        repo: "/home/user/harness",
      },
      { subagentRunner: runner },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Überlappende laufende Subagent-Tasks");

    // Clean up the registered task so the test leaves the supervisor clean.
    runningTask.status = "stopped";
    runningTask.finishedAt = new Date();
  });

  it("does not warn when running tasks have a disjoint topic", async () => {
    const runner = makeRunner();
    const runningTask = {
      id: "existing-2",
      type: "agent" as const,
      status: "stopped" as const,
      summary: "Refactor the voice channel — run pnpm test, fertig wenn grün",
      artifactPaths: [],
      startedAt: new Date(),
      finishedAt: new Date(),
      stop: () => {},
    };
    processSupervisor.registerTask(runningTask);

    const result = await subagentTool.execute(
      {
        action: "start",
        role: "coder",
        task: "Refactor the voice channel — run pnpm test, fertig wenn grün",
        repo: "/home/user/harness",
      },
      { subagentRunner: runner },
    );
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("Überlappende laufende Subagent-Tasks");
  });
});
