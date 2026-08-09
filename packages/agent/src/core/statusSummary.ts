import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveMetricsDir, traceTokenUsage } from "@harness/core";

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
  /** Model context window in tokens, used for the context-fill percentage. */
  contextWindow?: number;
  /** Current workspace / cwd */
  workspace?: string;
  /** "active" if agent is running, "ready" otherwise */
  sessionState: "active" | "ready";
  /** Session ID for correlating with JSONL metrics */
  sessionId?: string;
  /** Accumulated session token usage */
  sessionUsage?: { inputTokens: number; outputTokens: number; totalTokens: number; cacheRead: number; cacheWrite: number };
  /**
   * Estimated tokens currently in the session context (message history
   * + system prompt + tool definitions). Falls back to the session's
   * total input spend when not provided.
   */
  contextTokens?: number;
  /** Memory backend availability */
  memoryReady?: boolean;
  /** Tool calls in current session (from past turns) */
  toolCalls: number;
  /** Errors in current session (from past turns) */
  errors: number;
  /** Daemon info — present when running inside the daemon process */
  daemon?: DaemonStatusContext;
}

export interface DaemonStatusContext {
  pid: number;
  uptimeSeconds: number;
  gateways: string;
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
  /** Tokens spent by the current session, split in/out. */
  sessionTokensIn: string;
  sessionTokensOut: string;
  /** Context fill percentage (current context estimate / context window). */
  contextFill: string;
  cacheHitRate: string;
  toolCalls: string;
  errors: string;
  lastTurn: string;
  metricsPath: string;
  daemonPid: string;
  daemonUptime: string;
  gateways: string;
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

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
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

  const sessionTokensIn = context.sessionUsage
    ? formatTokens(context.sessionUsage.inputTokens + context.sessionUsage.cacheRead + context.sessionUsage.cacheWrite)
    : "n/a";

  const sessionTokensOut = context.sessionUsage
    ? formatTokens(context.sessionUsage.outputTokens)
    : "n/a";

  // Context fill: prefer the live context estimate (messages + prompt + tools,
  // matching the compaction trigger), fall back to the session's input spend.
  const contextTokens =
    context.contextTokens ??
    (context.sessionUsage
      ? context.sessionUsage.inputTokens + context.sessionUsage.cacheRead + context.sessionUsage.cacheWrite
      : undefined);

  const contextFill = context.contextWindow && contextTokens !== undefined
    ? `${Math.min(100, Math.round((contextTokens / context.contextWindow) * 100))}%`
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
    sessionTokensIn,
    sessionTokensOut,
    contextFill,
    cacheHitRate,
    toolCalls,
    errors,
    lastTurn,
    metricsPath: resolveMetricsDir() + "/",
    daemonPid: context.daemon ? String(context.daemon.pid) : "n/a",
    daemonUptime: context.daemon ? formatUptime(context.daemon.uptimeSeconds) : "n/a",
    gateways: context.daemon ? (context.daemon.gateways || "none configured") : "n/a",
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
    `Session:      ${summary.sessionTokensIn} in / ${summary.sessionTokensOut} out`,
    `Context fill: ${summary.contextFill}`,
    `Cache hit:    ${summary.cacheHitRate}`,
    `Session total: ${summary.sessionTokens}`,
    `Tool calls:   ${summary.toolCalls} today`,
    `Errors today: ${summary.errors}`,
    `Last turn:    ${summary.lastTurn}`,
    `Daemon PID:   ${summary.daemonPid}`,
    `Daemon up:    ${summary.daemonUptime}`,
    `Gateways:     ${summary.gateways}`,
    `Metrics:      ${summary.metricsPath}`,
  ];
  return lines.join("\n");
}
