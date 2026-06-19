import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readTodayMetrics,
  buildStatusSummary,
  formatStatusSummary,
  type StatusContext,
} from "../../src/core/statusSummary.js";

const TEST_DIR = join(tmpdir(), "harness-status-test-" + process.pid);

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

const baseContext: StatusContext = {
  model: "minimax-m2.7",
  workspace: "/home/user/dev/harness",
  sessionState: "ready",
  memoryReady: true,
  toolCalls: 5,
  errors: 0,
};

function dateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("readTodayMetrics", () => {
  it("returns null when metrics directory does not exist", async () => {
    const result = await readTodayMetrics(join(TEST_DIR, "nonexistent"));
    expect(result).toBeNull();
  });

  it("returns null when today's metric files do not exist", async () => {
    const result = await readTodayMetrics(TEST_DIR);
    expect(result).toBeNull();
  });

  it("reads and sums metrics from today's JSONL files", async () => {
    const date = new Date("2026-06-18T12:00:00Z");
    const d = dateStr(date);

    await writeFile(
      join(TEST_DIR, `turns-${d}.jsonl`),
      [
        JSON.stringify({ type: "turn", ts: "2026-06-18T12:00:00.000Z", inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheRead: 0, cacheWrite: 0, latencyMs: 4200, toolCallCount: 3, status: "ok" }),
        JSON.stringify({ type: "turn", ts: "2026-06-18T12:01:00.000Z", inputTokens: 2000, outputTokens: 800, totalTokens: 2800, cacheRead: 0, cacheWrite: 0, latencyMs: 8400, toolCallCount: 5, status: "ok" }),
      ].join("\n") + "\n",
    );
    await writeFile(
      join(TEST_DIR, `tools-${d}.jsonl`),
      [
        JSON.stringify({ type: "tool_call", ts: "2026-06-18T12:00:01.000Z", tool: "read_file", latencyMs: 120, status: "ok" }),
        JSON.stringify({ type: "tool_call", ts: "2026-06-18T12:00:02.000Z", tool: "edit", latencyMs: 80, status: "error", error: "not found" }),
      ].join("\n") + "\n",
    );
    await writeFile(
      join(TEST_DIR, `system-${d}.jsonl`),
      JSON.stringify({ type: "error", ts: "2026-06-18T12:02:00.000Z", scope: "agent_run", message: "boom" }) + "\n",
    );

    const result = await readTodayMetrics(TEST_DIR, date);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(3000);
    expect(result!.outputTokens).toBe(1300);
    expect(result!.totalTokens).toBe(4300);
    expect(result!.cacheRead).toBe(0);
    expect(result!.cacheWrite).toBe(0);
    expect(result!.toolCalls).toBe(2);
    expect(result!.errors).toBe(2); // 1 tool_call error + 1 system error
    expect(result!.lastTurnLatencyMs).toBe(8400);
  });

  it("skips corrupt JSON lines without crashing", async () => {
    const date = new Date("2026-06-18T12:00:00Z");
    const d = dateStr(date);

    await writeFile(
      join(TEST_DIR, `turns-${d}.jsonl`),
      [
        JSON.stringify({ type: "turn", ts: "2026-06-18T12:00:00.000Z", inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheRead: 0, cacheWrite: 0, latencyMs: 100, toolCallCount: 0, status: "ok" }),
        "{ broken json",
        "",
        JSON.stringify({ type: "turn", ts: "2026-06-18T12:00:01.000Z", inputTokens: 200, outputTokens: 100, totalTokens: 300, cacheRead: 0, cacheWrite: 0, latencyMs: 200, toolCallCount: 0, status: "ok" }),
      ].join("\n") + "\n",
    );

    const result = await readTodayMetrics(TEST_DIR, date);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(300);
    expect(result!.outputTokens).toBe(150);
    expect(result!.totalTokens).toBe(450);
  });

  it("handles empty file gracefully", async () => {
    const date = new Date("2026-06-18T12:00:00Z");
    const d = dateStr(date);

    await writeFile(join(TEST_DIR, `turns-${d}.jsonl`), "\n\n\n");

    const result = await readTodayMetrics(TEST_DIR, date);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(0);
    expect(result!.toolCalls).toBe(0);
    expect(result!.lastTurnLatencyMs).toBeNull();
  });

  it("handles partial entries (missing fields)", async () => {
    const date = new Date("2026-06-18T12:00:00Z");
    const d = dateStr(date);

    await writeFile(
      join(TEST_DIR, `turns-${d}.jsonl`),
      [
        JSON.stringify({ type: "turn", ts: "2026-06-18T12:00:00.000Z", inputTokens: 100, cacheRead: 0, cacheWrite: 0, latencyMs: 50, toolCallCount: 0, status: "ok" }),
      ].join("\n") + "\n",
    );
    await writeFile(
      join(TEST_DIR, `tools-${d}.jsonl`),
      [
        JSON.stringify({ type: "tool_call", ts: "2026-06-18T12:00:01.000Z", tool: "x", latencyMs: 10, status: "ok" }),
        JSON.stringify({ type: "tool_call", ts: "2026-06-18T12:00:02.000Z", tool: "y", latencyMs: 20, status: "ok" }),
      ].join("\n") + "\n",
    );

    const result = await readTodayMetrics(TEST_DIR, date);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(100);
    expect(result!.toolCalls).toBe(2);
    expect(result!.outputTokens).toBe(0);
  });

});

describe("buildStatusSummary", () => {
  it("degrades to n/a when no metrics and no session usage", async () => {
    const summary = await buildStatusSummary(
      { ...baseContext, sessionUsage: undefined },
      null,
    );
    expect(summary.tokensIn).toBe("n/a");
    expect(summary.tokensOut).toBe("n/a");
    expect(summary.lastTurn).toBe("n/a");
  });

  it("falls back to session usage when metrics are null", async () => {
    const summary = await buildStatusSummary(
      {
        ...baseContext,
        sessionUsage: { inputTokens: 12400, outputTokens: 3100, totalTokens: 15500, cacheRead: 0, cacheWrite: 0 },
      },
      null,
    );
    expect(summary.tokensIn).toBe("12.4k");
    expect(summary.tokensOut).toBe("3.1k");
  });

  it("prefers metrics over session usage", async () => {
    const summary = await buildStatusSummary(
      {
        ...baseContext,
        sessionUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheRead: 0, cacheWrite: 0 },
      },
      { inputTokens: 12400, outputTokens: 3100, totalTokens: 15500, cacheRead: 0, cacheWrite: 0, toolCalls: 18, errors: 0, lastTurnLatencyMs: 8400 },
    );
    expect(summary.tokensIn).toBe("12.4k");
    expect(summary.tokensOut).toBe("3.1k");
    expect(summary.toolCalls).toBe("18");
    expect(summary.errors).toBe("0");
    expect(summary.lastTurn).toBe("8.4s");
  });

  it("shows model and workspace from context", async () => {
    const summary = await buildStatusSummary(baseContext, null);
    expect(summary.model).toBe("minimax-m2.7");
    expect(summary.workspace).toBe("/home/user/dev/harness");
  });

  it("shows memory as ready when memoryReady is true", async () => {
    const summary = await buildStatusSummary(baseContext, null);
    expect(summary.memory).toBe("ready");
  });

  it("shows memory as n/a when memoryReady is false", async () => {
    const summary = await buildStatusSummary(
      { ...baseContext, memoryReady: false },
      null,
    );
    expect(summary.memory).toBe("n/a");
  });

  it("falls back to context toolCalls/errors when metrics are null", async () => {
    const summary = await buildStatusSummary(
      { ...baseContext, toolCalls: 5, errors: 2 },
      null,
    );
    expect(summary.toolCalls).toBe("5");
    expect(summary.errors).toBe("2");
  });

  it("formats latency in ms when under 1000", async () => {
    const summary = await buildStatusSummary(baseContext, {
      inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, errors: 0,
      lastTurnLatencyMs: 450,
    });
    expect(summary.lastTurn).toBe("450ms");
  });

  it("formats latency in seconds when >= 1000", async () => {
    const summary = await buildStatusSummary(baseContext, {
      inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, errors: 0,
      lastTurnLatencyMs: 8400,
    });
    expect(summary.lastTurn).toBe("8.4s");
  });
});

describe("formatStatusSummary", () => {
  it("contains Harness Status header", async () => {
    const summary = await buildStatusSummary(baseContext, null);
    const output = formatStatusSummary(summary);
    expect(output).toContain("Harness Status");
  });

  it("contains Workspace", async () => {
    const summary = await buildStatusSummary(baseContext, null);
    const output = formatStatusSummary(summary);
    expect(output).toContain("Workspace");
    expect(output).toContain("/home/user/dev/harness");
  });

  it("contains Tokens today", async () => {
    const summary = await buildStatusSummary(baseContext, {
      inputTokens: 12400, outputTokens: 3100, totalTokens: 15500, cacheRead: 0, cacheWrite: 0,
      toolCalls: 18, errors: 0, lastTurnLatencyMs: 8400,
    });
    const output = formatStatusSummary(summary);
    expect(output).toContain("Tokens today");
    expect(output).toContain("12.4k in / 3.1k out");
  });

  it("contains Metrics path", async () => {
    const summary = await buildStatusSummary(baseContext, null);
    const output = formatStatusSummary(summary);
    expect(output).toContain("Metrics:");
    expect(output).toContain(".harness/metrics");
  });

  it("is compact and human-readable (one line per field)", async () => {
    const summary = await buildStatusSummary(baseContext, null);
    const output = formatStatusSummary(summary);
    const lines = output.split("\n");
    expect(lines.length).toBe(11);
  });
});
