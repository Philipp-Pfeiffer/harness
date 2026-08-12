import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBrowserTool } from "../../src/tools/browser.js";
import type { AsyncBrowserRunner } from "../../src/browser/asyncRunner.js";
import { runBrowserSubAgent } from "../../src/browser/runner.js";

vi.mock("../../src/browser/runner.js", () => ({
  runBrowserSubAgent: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(runBrowserSubAgent).mockReset();
});

function makeRunnerMock(overrides: Partial<AsyncBrowserRunner> = {}): AsyncBrowserRunner {
  return {
    start: () => ({ ok: true, id: "task-123" }),
    status: () => ({ ok: true, status: "running", text: "--- browser task task-123 ---\nstatus: running\nruntime: 1s" }),
    stop: () => ({ ok: true, status: "stopped", text: "--- browser task task-123 ---\nstatus: stopped" }),
    listRunningIds: () => [],
    ...overrides,
  };
}

describe("browser tool — async actions", () => {
  it("start returns immediately with a task id", async () => {
    const tool = createBrowserTool({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
      asyncRunner: makeRunnerMock(),
    });

    const result = await tool.execute({ action: "start", task: "Find the report" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("task-123");
    expect(result.content).toContain("Do NOT wait");
  });

  it("start without task → error", async () => {
    const tool = createBrowserTool({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
      asyncRunner: makeRunnerMock(),
    });

    const result = await tool.execute({ action: "start" });
    expect(result.isError).toBe(true);
  });

  it("start propagates cap error from the runner", async () => {
    const tool = createBrowserTool({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
      asyncRunner: makeRunnerMock({
        start: () => ({ ok: false, error: "Max 2 concurrent", runningIds: ["a", "b"] }),
      }),
    });

    const result = await tool.execute({ action: "start", task: "Find the report" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Max 2 concurrent");
  });

  it("status without id → error", async () => {
    const tool = createBrowserTool({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
      asyncRunner: makeRunnerMock(),
    });

    const result = await tool.execute({ action: "status" });
    expect(result.isError).toBe(true);
  });

  it("status for unknown id → error", async () => {
    const tool = createBrowserTool({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
      asyncRunner: makeRunnerMock({
        status: () => ({ ok: false, error: "Browser task nope not found." }),
      }),
    });

    const result = await tool.execute({ action: "status", id: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("stop without id → error", async () => {
    const tool = createBrowserTool({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
      asyncRunner: makeRunnerMock(),
    });

    const result = await tool.execute({ action: "stop" });
    expect(result.isError).toBe(true);
  });

  it("stop for unknown id → error", async () => {
    const tool = createBrowserTool({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
      asyncRunner: makeRunnerMock({
        stop: () => ({ ok: false, error: "Browser task nope not found." }),
      }),
    });

    const result = await tool.execute({ action: "stop", id: "nope" });
    expect(result.isError).toBe(true);
  });
});

describe("browser tool — sync path unchanged", () => {
  it("calls the blocking runner with goal/successCriteria/resultFormat", async () => {
    vi.mocked(runBrowserSubAgent).mockResolvedValue({
      content: "# Browser Report\n\n**Goal achieved:** yes",
      isError: false,
      report: { goalAchieved: true, result: "ok", files: [], visitedUrls: [] },
    });

    const tool = createBrowserTool({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
    });

    const result = await tool.execute({
      goal: "Find the report",
      successCriteria: "downloaded",
      resultFormat: "markdown",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Goal achieved");
    expect(runBrowserSubAgent).toHaveBeenCalledOnce();
  });

  it("sync without required fields → error", async () => {
    const tool = createBrowserTool({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
    });

    const result = await tool.execute({ goal: "x" });
    expect(result.isError).toBe(true);
    expect(runBrowserSubAgent).not.toHaveBeenCalled();
  });
});
