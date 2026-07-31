import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserTraceWriter } from "../../src/browser/trace.js";

describe("BrowserTraceWriter", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "harness-browser-trace-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("writes run-start, tool calls, and run-end to JSONL", async () => {
    const trace = await BrowserTraceWriter.create({
      browserRunsDir: baseDir,
      sessionId: "sess-1",
      toolCallId: "call-abc",
      input: {
        goal: "open page",
        successCriteria: "title visible",
        resultFormat: "markdown",
        startUrl: "https://example.com",
      },
    });

    await trace.phase("connecting");
    await trace.toolCallStart("browser_snapshot", {});
    await trace.toolCallDone("browser_snapshot", "# Example", false);
    await trace.turnEnd();
    await trace.runEnd({ goalAchieved: true, isError: false, completedTurns: 1, toolCallCount: 1 });

    const raw = await readFile(trace.tracePath, "utf-8");
    const lines = raw.trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(lines.map((l) => l.type)).toEqual([
      "run-start",
      "phase",
      "turn-start",
      "tool-call-start",
      "tool-call-done",
      "turn-end",
      "run-end",
    ]);
    expect(lines[0]).toMatchObject({
      type: "run-start",
      sessionId: "sess-1",
      toolCallId: "call-abc",
    });
    expect(lines.at(-1)).toMatchObject({
      type: "run-end",
      goalAchieved: true,
      tracePath: trace.tracePath,
    });
  });

  it("truncates large snapshot results", async () => {
    const trace = await BrowserTraceWriter.create({
      browserRunsDir: baseDir,
      sessionId: "sess-2",
      input: {
        goal: "snap",
        successCriteria: "ok",
        resultFormat: "markdown",
      },
    });

    const huge = "x".repeat(10_000);
    await trace.toolCallDone("browser_snapshot", huge, false);
    const raw = await readFile(trace.tracePath, "utf-8");
    const done = JSON.parse(raw.trim().split("\n").at(-1)!) as { result: string };
    expect(done.result.length).toBeLessThan(huge.length);
    expect(done.result).toContain("truncated");
  });
});
