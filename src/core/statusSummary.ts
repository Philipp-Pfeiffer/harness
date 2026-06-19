import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/* ─── Types ─── */

export interface MetricsAggregate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
  /** Accumulated session token usage */
  sessionUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
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
  tokensIn: string;
  tokensOut: string;
  toolCalls: string;
  errors: string;
  lastTurn: string;
  metricsPath: string;
}

/* ─── Metrics Reader ─── */

/**
 * Reads today's JSONL metrics files from ~/.harness/metrics/.
 *
 * Expected file naming: YYYY-MM-DD.jsonl
 * Each line is a JSON object with optional fields:
 *   inputTokens, outputTokens, totalTokens, toolCalls, errors, latencyMs
 *
 * Robust against missing files, empty files, and corrupt lines.
 * Returns null if the metrics directory or today's file doesn't exist.
 */
export async function readTodayMetrics(
  metricsDir?: string,
  dateOverride?: Date,
): Promise<MetricsAggregate | null> {
  const dir = metricsDir ?? join(homedir(), ".harness", "metrics");
  const now = dateOverride ?? new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = join(dir, `${dateStr}.jsonl`);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const agg: MetricsAggregate = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    errors: 0,
    lastTurnLatencyMs: null,
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Partial<{
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        toolCalls: number;
        errors: number;
        latencyMs: number;
      }>;

      if (typeof entry.inputTokens === "number") agg.inputTokens += entry.inputTokens;
      if (typeof entry.outputTokens === "number") agg.outputTokens += entry.outputTokens;
      if (typeof entry.totalTokens === "number") agg.totalTokens += entry.totalTokens;
      if (typeof entry.toolCalls === "number") agg.toolCalls += entry.toolCalls;
      if (typeof entry.errors === "number") agg.errors += entry.errors;
      if (typeof entry.latencyMs === "number") agg.lastTurnLatencyMs = entry.latencyMs;
    } catch {
      // Skip corrupt lines silently
    }
  }

  return agg;
}

/* ─── Builder ─── */

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export async function buildStatusSummary(
  context: StatusContext,
  metricsOverride?: MetricsAggregate | null,
): Promise<StatusSummary> {
  const metrics = metricsOverride !== undefined ? metricsOverride : await readTodayMetrics();

  const tokensIn = metrics
    ? formatTokens(metrics.inputTokens)
    : context.sessionUsage
      ? formatTokens(context.sessionUsage.inputTokens)
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

  return {
    sessionState: context.sessionState,
    model: context.model ?? "n/a",
    workspace: context.workspace ?? process.cwd(),
    memory: context.memoryReady ? "ready" : "n/a",
    tokensIn,
    tokensOut,
    toolCalls,
    errors,
    lastTurn,
    metricsPath: join(homedir(), ".harness", "metrics") + "/",
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
    `Tokens today: ${summary.tokensIn} in / ${summary.tokensOut} out`,
    `Tool calls:   ${summary.toolCalls} today`,
    `Errors today: ${summary.errors}`,
    `Last turn:    ${summary.lastTurn}`,
    `Metrics:      ${summary.metricsPath}`,
  ];
  return lines.join("\n");
}
