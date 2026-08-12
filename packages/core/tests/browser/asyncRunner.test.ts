import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAsyncBrowserRunner } from "../../src/browser/asyncRunner.js";
import { processSupervisor } from "../../src/tools/processSupervisor.js";
import { runBrowserSubAgent } from "../../src/browser/runner.js";

vi.mock("../../src/browser/runner.js", () => ({
  runBrowserSubAgent: vi.fn(),
}));

const input = {
  goal: "Find the annual report",
  successCriteria: "report downloaded",
  resultFormat: "markdown" as const,
};

function runnerResult(content: string, isError: boolean) {
  return {
    content,
    isError,
    report: {
      goalAchieved: !isError,
      result: content,
      files: [],
      visitedUrls: [],
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("async browser runner", () => {
  afterEach(() => {
    vi.mocked(runBrowserSubAgent).mockReset();
    for (const task of processSupervisor.listTasks().running) {
      task.status = "stopped";
      task.finishedAt = new Date();
    }
  });

  it("start returns immediately with a task id (non-blocking)", async () => {
    let release: (() => void) = () => {};
    vi.mocked(runBrowserSubAgent).mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(runnerResult("done", false)); }),
    );

    const runner = createAsyncBrowserRunner({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
    });

    const started = Date.now();
    const result = runner.start(input);
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(100);
    release();
    await settle();
  });

  it("enforces the concurrency cap and reports running ids", async () => {
    vi.mocked(runBrowserSubAgent).mockImplementation(
      () => new Promise(() => {}),
    );

    const runner = createAsyncBrowserRunner({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
      maxConcurrent: 2,
    });

    const a = runner.start(input);
    const b = runner.start(input);
    const c = runner.start(input);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.runningIds.length).toBe(2);
    }
  });

  it("status/stop return not-found for unknown ids", () => {
    const runner = createAsyncBrowserRunner({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
    });

    expect(runner.status("nope").ok).toBe(false);
    expect(runner.stop("nope").ok).toBe(false);
  });

  it("stop transitions a running task to stopped", async () => {
    vi.mocked(runBrowserSubAgent).mockImplementation(() => new Promise(() => {}));

    const runner = createAsyncBrowserRunner({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
    });

    const started = runner.start(input);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const stopResult = runner.stop(started.id);
    expect(stopResult.ok).toBe(true);
    expect(stopResult.status).toBe("stopped");
  });

  it("status reports running state with runtime", async () => {
    vi.mocked(runBrowserSubAgent).mockImplementation(() => new Promise(() => {}));

    const runner = createAsyncBrowserRunner({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
    });

    const started = runner.start(input);
    if (!started.ok) return;

    const status = runner.status(started.id);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status).toBe("running");
    expect(status.text).toContain("runtime:");
  });

  it("injects a completion event with summary and artifact paths", async () => {
    const browserRunsDir = await mkdtemp(path.join(tmpdir(), "harness-async-"));
    const events: { origin: string; text: string }[] = [];

    vi.mocked(runBrowserSubAgent).mockImplementation(async (_id, _input, deps) => {
      // Simulate a trace artifact before completion.
      const { appendFile, mkdir } = await import("node:fs/promises");
      await mkdir(path.join(deps.browserRunsDir, _id), { recursive: true });
      await appendFile(path.join(deps.browserRunsDir, _id, "run.jsonl"), "{}\n");
      return runnerResult("report text", false);
    });

    const runner = createAsyncBrowserRunner({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir,
      injectSystemEvent: (e) => events.push(e),
    });

    const started = runner.start(input);
    expect(started.ok).toBe(true);

    // Poll until completion event fires.
    for (let i = 0; i < 100 && events.length === 0; i++) {
      await settle();
    }

    expect(events.length).toBe(1);
    expect(events[0]!.origin).toBe("Browser");
    expect(events[0]!.text).toContain("abgeschlossen");
    expect(events[0]!.text).toContain(".jsonl");
  });

  it("injects an error event when the runner crashes", async () => {
    const events: { origin: string; text: string }[] = [];
    vi.mocked(runBrowserSubAgent).mockImplementation(async () => {
      throw new Error("runner exploded");
    });

    const runner = createAsyncBrowserRunner({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
      injectSystemEvent: (e) => events.push(e),
    });

    const started = runner.start(input);
    expect(started.ok).toBe(true);

    for (let i = 0; i < 100 && events.length === 0; i++) {
      await settle();
    }

    expect(events.length).toBe(1);
    expect(events[0]!.text).toContain("fehlgeschlagen");
    expect(events[0]!.text).toContain("runner exploded");
  });

  it("times out after the configured timeout and emits an error event", async () => {
    const events: { origin: string; text: string }[] = [];
    vi.mocked(runBrowserSubAgent).mockImplementation(
      () => new Promise(() => {}),
    );

    const runner = createAsyncBrowserRunner({
      downloadsBaseDir: "/tmp/dl",
      browserRunsDir: "/tmp/runs",
      taskTimeoutMs: 50,
      injectSystemEvent: (e) => events.push(e),
    });

    const started = runner.start(input);
    expect(started.ok).toBe(true);

    for (let i = 0; i < 100 && events.length === 0; i++) {
      await settle();
    }

    expect(events.length).toBe(1);
    expect(events[0]!.text).toContain("timeout");
  });
});
