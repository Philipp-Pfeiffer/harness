/**
 * Token-Trace — debug visibility for the token usage pipeline.
 *
 * Set `HARNESS_TOKEN_TRACE=1` to emit one JSON line per stage to stderr.
 * Stages:
 *   1. provider-response  — raw `response.usage` from pi-ai
 *   2. agent-result       — aggregated `RunResult.usage` after a run()
 *   3. metrics-jsonl      — values written by `MetricsRecorder.recordTurn()`
 *   4. status-summary     — values read back from today's JSONL aggregate
 *
 * The emitted snapshots are intentionally raw numbers so they can be diffed
 * across stages without formatting ambiguity.
 */

export interface TokenTraceSnapshot {
  stage:
    | "provider-response"
    | "agent-result"
    | "metrics-jsonl"
    | "status-summary";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheRead: number;
  cacheWrite: number;
  extra?: Record<string, unknown>;
}

export interface TokenTraceUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

let _enabled: boolean | undefined;

function isEnabled(): boolean {
  if (_enabled !== undefined) return _enabled;
  const env = process.env.HARNESS_TOKEN_TRACE;
  _enabled = env === "1" || env === "true";
  return _enabled;
}

/** For tests only: override the enabled flag. */
export function setTokenTraceEnabled(enabled: boolean): void {
  _enabled = enabled;
}

/**
 * Emits a token-trace snapshot for one stage.
 * Output goes to stderr so it does not interfere with stdout consumers.
 */
export function traceTokenUsage(
  stage: TokenTraceSnapshot["stage"],
  usage: TokenTraceUsage,
  extra?: Record<string, unknown>,
): void {
  if (!isEnabled()) return;
  const snapshot: TokenTraceSnapshot = { stage, ...usage };
  if (extra && Object.keys(extra).length > 0) {
    snapshot.extra = extra;
  }
  console.error("[TOKEN-TRACE] " + JSON.stringify(snapshot));
}
