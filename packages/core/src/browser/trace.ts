import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TokenUsage } from "../core/agent.js";
import type { BrowserToolInput } from "./types.js";

export type BrowserTraceEvent = {
  ts?: string;
} & (
  | {
      type: "run-start";
      runId: string;
      sessionId: string;
      toolCallId?: string;
      input: BrowserToolInput;
    }
  | { type: "phase"; phase: string }
  | { type: "turn-start"; turn: number }
  | { type: "turn-end"; turn: number }
  | { type: "tool-call-start"; turn: number; name: string; args: unknown }
  | { type: "tool-call-done"; turn: number; name: string; result: string; isError: boolean }
  | { type: "tool-call-error"; turn: number; name: string; error: string }
  | {
      type: "run-end";
      goalAchieved: boolean;
      isError: boolean;
      usage?: TokenUsage;
      completedTurns?: number;
      toolCallCount?: number;
      failureReason?: string;
      tracePath: string;
    }
);

const SNAPSHOT_TRACE_MAX = 4_000;
const DEFAULT_TRACE_MAX = 2_000;
const SCREENSHOT_TRACE_MAX = 200;

function truncateTraceResult(name: string, result: string): string {
  const max =
    name === "browser_snapshot"
      ? SNAPSHOT_TRACE_MAX
      : name === "browser_screenshot"
        ? SCREENSHOT_TRACE_MAX
        : DEFAULT_TRACE_MAX;
  if (result.length <= max) return result;
  return `${result.slice(0, max)}\n… [truncated, ${result.length} chars total]`;
}

export class BrowserTraceWriter {
  readonly runId: string;
  readonly tracePath: string;
  private turn = 0;
  private turnOpen = false;

  private constructor(runId: string, tracePath: string) {
    this.runId = runId;
    this.tracePath = tracePath;
  }

  static async create(opts: {
    browserRunsDir: string;
    sessionId: string;
    toolCallId?: string;
    input: BrowserToolInput;
  }): Promise<BrowserTraceWriter> {
    const runId = `${formatRunTimestamp()}-${randomUUID().slice(0, 8)}`;
    const dir = path.join(opts.browserRunsDir, opts.sessionId);
    await mkdir(dir, { recursive: true });
    const tracePath = path.join(dir, `${runId}.jsonl`);
    const writer = new BrowserTraceWriter(runId, tracePath);
    await writer.append({
      type: "run-start",
      runId,
      sessionId: opts.sessionId,
      toolCallId: opts.toolCallId,
      input: opts.input,
    });
    return writer;
  }

  async phase(phase: string): Promise<void> {
    await this.append({ type: "phase", phase });
  }

  async ensureTurnStarted(): Promise<void> {
    if (this.turnOpen) return;
    this.turn += 1;
    this.turnOpen = true;
    await this.append({ type: "turn-start", turn: this.turn });
  }

  async turnEnd(): Promise<void> {
    if (!this.turnOpen) return;
    await this.append({ type: "turn-end", turn: this.turn });
    this.turnOpen = false;
  }

  async toolCallStart(name: string, args: unknown): Promise<void> {
    await this.ensureTurnStarted();
    await this.append({ type: "tool-call-start", turn: this.turn, name, args });
  }

  async toolCallDone(name: string, result: string, isError: boolean): Promise<void> {
    await this.append({
      type: "tool-call-done",
      turn: this.turn,
      name,
      result: truncateTraceResult(name, result),
      isError,
    });
  }

  async toolCallError(name: string, error: string): Promise<void> {
    await this.append({ type: "tool-call-error", turn: this.turn, name, error });
  }

  async runEnd(event: Omit<Extract<BrowserTraceEvent, { type: "run-end" }>, "type" | "tracePath" | "ts">): Promise<void> {
    await this.append({ type: "run-end", tracePath: this.tracePath, ...event });
  }

  private async append(event: BrowserTraceEvent): Promise<void> {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    await appendFile(this.tracePath, line, "utf-8");
  }
}

function formatRunTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
