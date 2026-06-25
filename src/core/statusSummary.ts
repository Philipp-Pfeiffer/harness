import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveMetricsDir } from "./metrics.js";
import { traceTokenUsage } from "./tokenTrace.js";

/* ─── Types ─── */

export interface MetricsAggregate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheRead: number;
  cacheWrite: number;
  toolCalls: number;
  errors: number;
  lastTurnLatencyMs: number | null;
}

export interface StatusContext {
  /** Active model ID, e.g. "minimax-m2.7" */
  model?: string;
  /** Current workspace / cwd */
  workspace?: string;
  /** "active" if agent is running, "ready" otherwise */
  sessionState: "active" | "ready";
  /** Session ID for correlating with JSONL metrics */
  sessionId?: string;
  /** Accumulated session token usage */
  sessionUsage?: { inputTokens: number; outputTokens: number; totalTokens: number; cacheRead: number; cacheWrite: number };
  /** Memory backend availability */
  memoryReady?: boolean;
  /** Tool calls in current session (from past turns) */
  toolCalls: number;
  /** Errors in current session (from past turns) */
  errors: number;
}

export interface StatusSummary {
  sessionState: string;
  model: string;
  workspace: string;
  memory: string;
  sessionId: string;
  tokensIn: string;
  tokensOut: string;
  sessionTokens: string;
  cacheHitRate: string;
  toolCalls: string;
  errors: string;
  lastTurn: string;
  metricsPath: string;
}

/* ─── Metrics Reader ─── */

/**
 * Reads today's JSONL metrics files from the metrics directory.
 *
 * The metrics directory defaults to `~/.harness/metrics/` and can be
 * overridden via the `HARNESS_METRICS_DIR` environment variable.
 *
 * Expected files (all optional):
 *   - turns-YYYY-MM-DD.jsonl  → turn events
 *   - tools-YYYY-MM-DD.jsonl  → tool_call events
 *   - system-YYYY-MM-DD.jsonl → error events
 *
 * Returns null if none of today's metric files exist. Empty or corrupt
 * lines are skipped silently.
 */
export async function readTodayMetrics(
  metricsDir?: string,
  dateOverride?: Date,
): Promise<MetricsAggregate | null> {
  const dir = metricsDir ?? resolveMetricsDir();
  const now = dateOverride ?? new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  const prefixes = ["turns", "tools", "system"] as const;
  const files = prefixes.map((prefix) => join(dir, `${prefix}-${dateStr}.jsonl`));

  const contents: string[] = [];
  let anyExists = false;
  for (const filePath of files) {
    try {
      contents.push(await readFile(filePath, "utf-8"));
      anyExists = true;
    } catch {
      contents.push("");
    }
  }

  if (!anyExists) {
    return null;
  }

  const agg: MetricsAggregate = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCalls: 0,
    errors: 0,
    lastTurnLatencyMs: null,
  };

  function processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const entry = JSON.parse(trimmed) as Partial<{
        type: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cacheRead: number;
        cacheWrite: number;
        latencyMs: number;
        status: string;
      }>;

      if (entry.type === "turn") {
        if (typeof entry.inputTokens === "number") agg.inputTokens += entry.inputTokens;
        if (typeof entry.outputTokens === "number") agg.outputTokens += entry.outputTokens;
        if (typeof entry.totalTokens === "number") agg.totalTokens += entry.totalTokens;
        if (typeof entry.cacheRead === "number") agg.cacheRead += entry.cacheRead;
        if (typeof entry.cacheWrite === "number") agg.cacheWrite += entry.cacheWrite;
        if (typeof entry.latencyMs === "number") agg.lastTurnLatencyMs = entry.latencyMs;
        if (entry.status === "error") agg.errors++;
      } else if (entry.type === "tool_call") {
        agg.toolCalls++;
        if (entry.status === "error") agg.errors++;
      } else if (entry.type === "error") {
        agg.errors++;
      }
    } catch {
      // Skip corrupt lines silently
    }
  }

  for (const raw of contents) {
    for (const line of raw.split("\n")) {
      processLine(line);
    }
  }

  traceTokenUsage("status-summary", {
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    totalTokens: agg.totalTokens,
    cacheRead: agg.cacheRead,
    cacheWrite: agg.cacheWrite,
  }, { toolCalls: agg.toolCalls, errors: agg.errors });

  return agg;
}

/* ─── Builder ─── */

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCacheHitRate(inputTokens: number, cacheRead: number, cacheWrite: number): string {
  const denom = inputTokens + cacheRead + cacheWrite;
  if (denom === 0) return "n/a";
  const rate = (cacheRead / denom) * 100;
  return `${rate.toFixed(1)}%`;
}

export async function buildStatusSummary(
  context: StatusContext,
  metricsOverride?: MetricsAggregate | null,
): Promise<StatusSummary> {
  const metrics = metricsOverride !== undefined ? metricsOverride : await readTodayMetrics();

  const tokensIn = metrics
    ? formatTokens(metrics.inputTokens + metrics.cacheRead + metrics.cacheWrite)
    : context.sessionUsage
      ? formatTokens(context.sessionUsage.inputTokens + context.sessionUsage.cacheRead + context.sessionUsage.cacheWrite)
      : "n/a";

  const tokensOut = metrics
    ? formatTokens(metrics.outputTokens)
    : context.sessionUsage
      ? formatTokens(context.sessionUsage.outputTokens)
      : "n/a";

  const toolCalls = metrics
    ? String(metrics.toolCalls)
    : String(context.toolCalls);

  const errors = metrics
    ? String(metrics.errors)
    : String(context.errors);

  const lastTurn = metrics ? formatLatency(metrics.lastTurnLatencyMs) : "n/a";

  const sessionTokens = context.sessionUsage
    ? formatTokens(context.sessionUsage.totalTokens)
    : "n/a";

  const cacheHitRate = metrics
    ? formatCacheHitRate(metrics.inputTokens, metrics.cacheRead, metrics.cacheWrite)
    : "n/a";

  return {
    sessionState: context.sessionState,
    model: context.model ?? "n/a",
    workspace: context.workspace ?? process.cwd(),
    memory: context.memoryReady ? "ready" : "n/a",
    sessionId: context.sessionId ?? "n/a",
    tokensIn,
    tokensOut,
    sessionTokens,
    cacheHitRate,
    toolCalls,
    errors,
    lastTurn,
    metricsPath: resolveMetricsDir() + "/",
  };
}

/* ─── Formatter ─── */

export function formatStatusSummary(summary: StatusSummary): string {
  const lines = [
    "Harness Status",
    "──────────────",
    `Session:      ${summary.sessionState}`,
    `Model:        ${summary.model}`,
    `Workspace:    ${summary.workspace}`,
    `Memory:       ${summary.memory}`,
    `Session ID:   ${summary.sessionId}`,
    `Tokens today: ${summary.tokensIn} in / ${summary.tokensOut} out`,
    `Cache hit:    ${summary.cacheHitRate}`,
    `Session:      ${summary.sessionTokens}`,
    `Tool calls:   ${summary.toolCalls} today`,
    `Errors today: ${summary.errors}`,
    `Last turn:    ${summary.lastTurn}`,
    `Metrics:      ${summary.metricsPath}`,
  ];
  return lines.join("\n");
}
