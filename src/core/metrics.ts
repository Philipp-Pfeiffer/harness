import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Event Types ───────────────────────────────────────────────

export interface TurnMetric {
  ts: string;
  type: "turn";
  sessionId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  toolCallCount: number;
  status: "ok" | "aborted" | "error";
}

export interface ToolCallMetric {
  ts: string;
  type: "tool_call";
  sessionId?: string;
  tool: string;
  latencyMs: number;
  status: "ok" | "error";
  error?: string;
}

export interface ErrorMetric {
  ts: string;
  type: "error";
  sessionId?: string;
  scope: string;
  message: string;
}

export type MetricEvent = TurnMetric | ToolCallMetric | ErrorMetric;

// ─── Directory Resolution ──────────────────────────────────────

/**
 * Resolves the metrics directory.
 *
 * Default: `~/.harness/metrics/` — following the existing `~/.harness/`
 * convention from config.ts.
 *
 * Override via `HARNESS_METRICS_DIR` env var for testing.
 */
export function resolveMetricsDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string {
  if (env.HARNESS_METRICS_DIR) {
    return env.HARNESS_METRICS_DIR;
  }
  return join(home, ".harness", "metrics");
}

// ─── JSONL Append ──────────────────────────────────────────────

/** Prefix for daily metric files, mapped by event type. */
const FILE_PREFIX: Record<MetricEvent["type"], string> = {
  turn: "turns",
  tool_call: "tools",
  error: "system",
};

/** Returns YYYY-MM-DD in UTC for consistent daily rotation. */
function dateKey(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Appends a single metric event as one JSON line to the appropriate
 * daily JSONL file. Creates the metrics directory if it doesn't exist.
 *
 * Never throws — all errors are swallowed (best-effort fire-and-forget).
 */
export async function appendMetric(
  event: MetricEvent,
  dir: string = resolveMetricsDir()
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const filename = `${FILE_PREFIX[event.type]}-${dateKey(event.ts)}.jsonl`;
    const line = JSON.stringify(event) + "\n";
    await appendFile(join(dir, filename), line, "utf-8");
  } catch {
    // Metrics must never crash the main process.
  }
}

// ─── Recorder ──────────────────────────────────────────────────

export interface MetricsRecorder {
  recordTurn(metric: Omit<TurnMetric, "ts" | "type">): void;
  recordToolCall(metric: Omit<ToolCallMetric, "ts" | "type">): void;
  recordError(metric: Omit<ErrorMetric, "ts" | "type">): void;
}

/**
 * Creates a metrics recorder that appends events as fire-and-forget
 * JSONL writes. All methods are synchronous (void) and never throw.
 *
 * @param options.dir   Override metrics directory (for tests).
 * @param options.sessionId  Optional session ID stamped on every event.
 */
export function createMetricsRecorder(options?: {
  dir?: string;
  sessionId?: string;
}): MetricsRecorder {
  const dir = options?.dir ?? resolveMetricsDir();
  const sessionId = options?.sessionId;

  function stamp<T extends Record<string, unknown>>(
    metric: T,
    type: MetricEvent["type"]
  ): MetricEvent {
    return {
      ts: new Date().toISOString(),
      type,
      ...metric,
      ...(sessionId !== undefined ? { sessionId } : {}),
    } as unknown as MetricEvent;
  }

  return {
    recordTurn(metric) {
      void appendMetric(stamp(metric, "turn"), dir);
    },
    recordToolCall(metric) {
      void appendMetric(stamp(metric, "tool_call"), dir);
    },
    recordError(metric) {
      void appendMetric(stamp(metric, "error"), dir);
    },
  };
}
