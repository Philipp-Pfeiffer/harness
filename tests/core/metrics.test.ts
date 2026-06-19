import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, readFile, access, chmod, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveMetricsDir,
  appendMetric,
  createMetricsRecorder,
  type TurnMetric,
  type ToolCallMetric,
  type ErrorMetric,
} from "../../src/core/metrics.js";

const BASE_DIR = resolve(tmpdir(), `harness-metrics-test-${Date.now()}`);

async function readJsonl(dir: string, prefix: string): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  const { readdir } = await import("node:fs/promises");
  try {
    const files = (await readdir(dir)).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".jsonl"));
    for (const file of files) {
      const raw = await readFile(join(dir, file), "utf-8");
      for (const line of raw.trim().split("\n")) {
        if (line) entries.push(JSON.parse(line));
      }
    }
  } catch {
    // directory or files don't exist yet
  }
  return entries;
}

describe("metrics", () => {
  beforeEach(() => {
    process.env.HARNESS_METRICS_DIR = BASE_DIR;
  });

  afterEach(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  // ─── resolveMetricsDir ─────────────────────────────────────

  describe("resolveMetricsDir", () => {
    it("uses HARNESS_METRICS_DIR when set", () => {
      const dir = resolveMetricsDir({ HARNESS_METRICS_DIR: "/custom/metrics" });
      expect(dir).toBe("/custom/metrics");
    });

    it("defaults to ~/.harness/metrics", () => {
      const dir = resolveMetricsDir({}, "/home/user");
      expect(dir).toBe(join("/home/user", ".harness", "metrics"));
    });

    it("ignores HARNESS_METRICS_DIR when empty string", () => {
      const dir = resolveMetricsDir({ HARNESS_METRICS_DIR: undefined }, "/home/user");
      expect(dir).toBe(join("/home/user", ".harness", "metrics"));
    });
  });

  // ─── appendMetric ──────────────────────────────────────────

  describe("appendMetric", () => {
    it("creates the metrics directory and appends a JSON line", async () => {
      const dir = resolve(BASE_DIR, "sub1");
      const event: TurnMetric = {
        ts: "2026-06-18T18:45:00.000Z",
        type: "turn",
        latencyMs: 4210,
        toolCallCount: 2,
        status: "ok",
      };
      await appendMetric(event, dir);

      // Directory exists
      await access(dir);

      const entries = await readJsonl(dir, "turns");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(event);
    });

    it("appends multiple events without overwriting", async () => {
      const dir = resolve(BASE_DIR, "sub2");
      await appendMetric({ ts: "2026-06-18T18:45:00.000Z", type: "turn", latencyMs: 100, toolCallCount: 0, status: "ok" }, dir);
      await appendMetric({ ts: "2026-06-18T18:46:00.000Z", type: "turn", latencyMs: 200, toolCallCount: 1, status: "ok" }, dir);
      await appendMetric({ ts: "2026-06-18T18:47:00.000Z", type: "turn", latencyMs: 300, toolCallCount: 2, status: "error" }, dir);

      const entries = await readJsonl(dir, "turns");
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({ latencyMs: 100 });
      expect(entries[1]).toMatchObject({ latencyMs: 200 });
      expect(entries[2]).toMatchObject({ status: "error" });
    });

    it("writes tool_call events to tools-*.jsonl", async () => {
      const dir = resolve(BASE_DIR, "sub3");
      const event: ToolCallMetric = {
        ts: "2026-06-18T18:45:02.000Z",
        type: "tool_call",
        tool: "read_file",
        latencyMs: 120,
        status: "ok",
      };
      await appendMetric(event, dir);

      const turns = await readJsonl(dir, "turns");
      const tools = await readJsonl(dir, "tools");
      expect(turns).toHaveLength(0);
      expect(tools).toHaveLength(1);
      expect(tools[0]).toEqual(event);
    });

    it("writes error events to system-*.jsonl", async () => {
      const dir = resolve(BASE_DIR, "sub4");
      const event: ErrorMetric = {
        ts: "2026-06-18T18:46:00.000Z",
        type: "error",
        scope: "agent_run",
        message: "something went wrong",
      };
      await appendMetric(event, dir);

      const tools = await readJsonl(dir, "tools");
      const system = await readJsonl(dir, "system");
      expect(tools).toHaveLength(0);
      expect(system).toHaveLength(1);
      expect(system[0]).toEqual(event);
    });

    it("uses UTC date for daily filename", async () => {
      const dir = resolve(BASE_DIR, "sub5");
      // Use a specific UTC date
      await appendMetric({ ts: "2026-03-15T23:59:00.000Z", type: "turn", latencyMs: 10, toolCallCount: 0, status: "ok" }, dir);
      await appendMetric({ ts: "2026-03-16T00:01:00.000Z", type: "turn", latencyMs: 10, toolCallCount: 0, status: "ok" }, dir);

      // Should have two separate files
      const { readdir } = await import("node:fs/promises");
      const files = (await readdir(dir)).sort();
      expect(files).toContain("turns-2026-03-15.jsonl");
      expect(files).toContain("turns-2026-03-16.jsonl");
    });

    it("JSONL is parseable, one JSON object per line", async () => {
      const dir = resolve(BASE_DIR, "sub6");
      await appendMetric({ ts: new Date().toISOString(), type: "turn", latencyMs: 50, toolCallCount: 1, status: "ok", inputTokens: 100, outputTokens: 50, totalTokens: 150 }, dir);

      const dateKey = new Date().toISOString().slice(0, 10);
      const raw = await readFile(join(dir, `turns-${dateKey}.jsonl`), "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe("turn");
      expect(parsed.inputTokens).toBe(100);
    });

    it("does not throw on write failure (graceful degradation)", async () => {
      // Create a directory where we can't write (make it read-only)
      const dir = resolve(BASE_DIR, "readonly");
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o444);

      // Should not throw
      await expect(
        appendMetric({ ts: new Date().toISOString(), type: "turn", latencyMs: 10, toolCallCount: 0, status: "ok" }, dir)
      ).resolves.toBeUndefined();

      // Cleanup: restore permissions
      await chmod(dir, 0o755);
    });

    it("handles unicode in error messages", async () => {
      const dir = resolve(BASE_DIR, "sub7");
      const unicodeMsg = "Fehler: Datei nicht gefunden — Überprüfung fehlgeschlagen ✓";
      await appendMetric({ ts: new Date().toISOString(), type: "error", scope: "tool", message: unicodeMsg }, dir);

      const entries = await readJsonl(dir, "system");
      expect(entries).toHaveLength(1);
      expect((entries[0] as ErrorMetric).message).toBe(unicodeMsg);
    });
  });

  // ─── createMetricsRecorder ─────────────────────────────────

  describe("createMetricsRecorder", () => {
    it("records turn events with auto-generated ts", async () => {
      const dir = resolve(BASE_DIR, "rec1");
      const recorder = createMetricsRecorder({ dir });

      recorder.recordTurn({ latencyMs: 500, toolCallCount: 3, status: "ok", inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });

      // Wait for fire-and-forget write
      await new Promise((r) => setTimeout(r, 50));

      const entries = await readJsonl(dir, "turns");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        type: "turn",
        latencyMs: 500,
        toolCallCount: 3,
        status: "ok",
        inputTokens: 1000,
      });
      expect(typeof (entries[0] as TurnMetric).ts).toBe("string");
    });

    it("records tool call events", async () => {
      const dir = resolve(BASE_DIR, "rec2");
      const recorder = createMetricsRecorder({ dir });

      recorder.recordToolCall({ tool: "exec", latencyMs: 300, status: "ok" });
      recorder.recordToolCall({ tool: "exec", latencyMs: 100, status: "error", error: "Command failed" });

      await new Promise((r) => setTimeout(r, 50));

      const entries = await readJsonl(dir, "tools");
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ tool: "exec", status: "ok" });
      expect(entries[1]).toMatchObject({ tool: "exec", status: "error", error: "Command failed" });
    });

    it("records error events", async () => {
      const dir = resolve(BASE_DIR, "rec3");
      const recorder = createMetricsRecorder({ dir });

      recorder.recordError({ scope: "agent_run", message: "Provider error" });

      await new Promise((r) => setTimeout(r, 50));

      const entries = await readJsonl(dir, "system");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ scope: "agent_run", message: "Provider error" });
    });

    it("stamps sessionId on all events when provided", async () => {
      const dir = resolve(BASE_DIR, "rec4");
      const recorder = createMetricsRecorder({ dir, sessionId: "sess-123" });

      recorder.recordTurn({ latencyMs: 100, toolCallCount: 0, status: "ok" });
      recorder.recordToolCall({ tool: "read_file", latencyMs: 50, status: "ok" });
      recorder.recordError({ scope: "test", message: "err" });

      await new Promise((r) => setTimeout(r, 50));

      const turns = await readJsonl(dir, "turns");
      const tools = await readJsonl(dir, "tools");
      const system = await readJsonl(dir, "system");

      expect((turns[0] as TurnMetric).sessionId).toBe("sess-123");
      expect((tools[0] as ToolCallMetric).sessionId).toBe("sess-123");
      expect((system[0] as ErrorMetric).sessionId).toBe("sess-123");
    });

    it("omits sessionId when not provided", async () => {
      const dir = resolve(BASE_DIR, "rec5");
      const recorder = createMetricsRecorder({ dir });

      recorder.recordTurn({ latencyMs: 100, toolCallCount: 0, status: "ok" });

      await new Promise((r) => setTimeout(r, 50));

      const entries = await readJsonl(dir, "turns");
      expect(entries[0]).not.toHaveProperty("sessionId");
    });

    it("undefined optional fields do not break JSON", async () => {
      const dir = resolve(BASE_DIR, "rec6");
      const recorder = createMetricsRecorder({ dir });

      // Turn metric without token fields — they're optional, should be omitted by JSON.stringify
      recorder.recordTurn({ latencyMs: 100, toolCallCount: 0, status: "ok" });

      await new Promise((r) => setTimeout(r, 50));

      const entries = await readJsonl(dir, "turns");
      expect(entries).toHaveLength(1);
      // Should not have inputTokens/outputTokens/totalTokens since they were undefined
      expect(entries[0]).not.toHaveProperty("inputTokens");
      expect(entries[0]).not.toHaveProperty("outputTokens");
      expect(entries[0]).not.toHaveProperty("totalTokens");
    });

    it("never throws on write failure", async () => {
      const dir = resolve(BASE_DIR, "rec-readonly");
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o444);

      const recorder = createMetricsRecorder({ dir });

      // Should not throw
      expect(() => recorder.recordTurn({ latencyMs: 10, toolCallCount: 0, status: "ok" })).not.toThrow();
      expect(() => recorder.recordError({ scope: "test", message: "err" })).not.toThrow();

      await new Promise((r) => setTimeout(r, 50));

      await chmod(dir, 0o755);
    });
  });
});
