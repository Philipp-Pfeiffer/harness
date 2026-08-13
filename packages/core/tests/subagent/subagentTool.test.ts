import { describe, it, expect } from "vitest";
import { subagentTool } from "../../src/tools/subagent.js";
import type { SubagentRunner } from "../../src/tools/types.js";

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
      { action: "start", role: "coder", task: "fix it", repo: "/repo" },
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
      { action: "start", role: "coder", task: "x" },
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
      { action: "start", role: "coder", task: "x" },
      { subagentRunner: runner, sessionId: "session-9" },
    );
    expect(received).toMatchObject({ role: "coder", task: "x", requesterSessionId: "session-9" });
  });
});
