import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { Tool, ToolCallContext } from "./types.js";
import { ok, err } from "./types.js";
import type { BrowserConfig } from "../browser/config.js";
import type { ConfigModel } from "../config.js";
import { runBrowserSubAgent } from "../browser/runner.js";
import type { BrowserToolInput } from "../browser/types.js";
import {
  createAsyncBrowserRunner,
  type AsyncBrowserRunner,
  type BrowserSystemEvent,
} from "../browser/asyncRunner.js";

const BrowserArgs = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal("start"),
    Type.Literal("status"),
    Type.Literal("stop"),
  ], {
    description:
      "Async mode: 'start' launches a background browser task and returns immediately; 'status' polls a task; 'stop' aborts a task. Omit for the synchronous (blocking) behavior.",
  })),
  task: Type.Optional(Type.String({
    minLength: 1,
    description:
      "Async start: concrete goal for the background browser task, e.g. \"Find and download the 2025 annual report PDF from example.com\".",
  })),
  id: Type.Optional(Type.String({
    minLength: 1,
    description: "Async status/stop: task id returned by a previous 'start' action.",
  })),
  goal: Type.Optional(Type.String({
    minLength: 1,
    description:
      "Synchronous mode: concrete goal for the browser sub-agent, e.g. \"Find and download the 2025 annual report PDF from example.com\".",
  })),
  successCriteria: Type.Optional(Type.String({
    minLength: 1,
    description:
      "Synchronous mode: verifiable success condition, e.g. \"PDF saved to downloads and URL of report page recorded\".",
  })),
  resultFormat: Type.Optional(Type.Union([
    Type.Literal("markdown"),
    Type.Literal("json"),
    Type.Literal("files"),
  ], {
    description: "Synchronous mode: how the sub-agent should structure its final report.",
  })),  startUrl: Type.Optional(Type.String({
    description: "URL to open first. Strongly recommended — avoids vague exploration.",
  })),
  context: Type.Optional(Type.String({
    description:
      "Relevant context: expected consent walls, language, login state, selectors hints, etc.",
  })),
});

type BrowserArgsType = {
  action?: "start" | "status" | "stop";
  task?: string;
  id?: string;
  goal?: string;
  successCriteria?: string;
  resultFormat?: "markdown" | "json" | "files";
  startUrl?: string;
  context?: string;
};

const BROWSER_TOOL_DESCRIPTION = `Delegate a web browsing task to a dedicated browser sub-agent.

Two modes:

## Async (preferred for long research)
Use action: "start" with a single "task" string to launch a background browser
session. The tool returns IMMEDIATELY with a task id — do NOT wait for the
result. Tell the user the task is running, then use action: "status" (with the
id) later, or let the completion event report back automatically. Max 2 browser
tasks run concurrently. Use action: "stop" to abort a running task.

## Sync (blocking)
Omit "action" and provide goal, successCriteria, resultFormat (and optional
startUrl/context). The tool blocks until the sub-agent finishes and returns the
full report.

The sub-agent operates a real browser via CDP (Obscura or Chrome) and returns a
structured report. You do NOT have direct browser tools — this is the only
interface.

## How to task well
- State a **concrete goal** and **verifiable success criteria**.
- Specify **resultFormat**: markdown (human-readable), json (structured), or files (paths only).
- Provide a **startUrl** when possible — do not make the agent guess where to begin.
- Add **context** for consent banners, language, expected UI patterns, known blockers.

## Anti-pattern (do NOT do this)
goal: "look at this site"
successCriteria: "tell me what you find"
→ Too vague. The sub-agent will waste turns and may fail structurally.

## Returns
Sync: structured report with goalAchieved, result text, file paths, visited URLs, and optional blockers.
Async: a task id to poll via status/stop.`;

export interface CreateBrowserToolOptions {
  browserConfig?: BrowserConfig;
  defaultModel?: ConfigModel;
  models?: ConfigModel[];
  /** Base directory for session downloads (e.g. $HARNESS_STATE/downloads). */
  downloadsBaseDir: string;
  /** Base directory for browser run traces (e.g. $HARNESS_STATE/browser-runs). */
  browserRunsDir: string;
  logger?: (msg: string, level?: "warn" | "debug") => void;
  /** System event bus for async completion notifications. */
  injectSystemEvent?: (event: BrowserSystemEvent) => void;
  /** Max concurrent async browser tasks (default 2). */
  maxConcurrent?: number;
  /** Per-task timeout in ms (default 30 min). */
  taskTimeoutMs?: number;
  /** Override the async runner (tests). */
  asyncRunner?: AsyncBrowserRunner;
}

function toBrowserToolInput(args: BrowserArgsType): BrowserToolInput {
  return {
    goal: args.goal ?? "",
    successCriteria: args.successCriteria ?? "",
    resultFormat: args.resultFormat ?? "markdown",
    startUrl: args.startUrl,
    context: args.context,
  };
}

export function createBrowserTool(opts: CreateBrowserToolOptions): Tool<typeof BrowserArgs> {
  const asyncRunner = opts.asyncRunner ?? createAsyncBrowserRunner({
    browserConfig: opts.browserConfig,
    defaultModel: opts.defaultModel,
    models: opts.models,
    downloadsBaseDir: opts.downloadsBaseDir,
    browserRunsDir: opts.browserRunsDir,
    logger: opts.logger,
    injectSystemEvent: opts.injectSystemEvent,
    maxConcurrent: opts.maxConcurrent,
    taskTimeoutMs: opts.taskTimeoutMs,
  });

  return {
    name: "browser",
    description: BROWSER_TOOL_DESCRIPTION,
    parameters: BrowserArgs,
    conflictKey: (args) => (args.action ? null : "browser-session"),
    async execute(args: BrowserArgsType, context?: ToolCallContext) {
      switch (args.action) {
        case "start": {
          if (!args.task) {
            return err("task is required for action 'start'");
          }
          const result = asyncRunner.start({
            goal: args.task,
            successCriteria: "task completed",
            resultFormat: "markdown",
          });
          if (!result.ok) {
            return err(result.error);
          }
          return ok(
            `Browser task started (id: ${result.id}). ` +
            `Poll with action "status" and this id, or wait for the completion event. ` +
            `Do NOT wait for the result now.`,
          );
        }
        case "status": {
          if (!args.id) {
            return err("id is required for action 'status'");
          }
          const result = asyncRunner.status(args.id);
          return result.ok ? ok(result.text) : err(result.error);
        }
        case "stop": {
          if (!args.id) {
            return err("id is required for action 'stop'");
          }
          const result = asyncRunner.stop(args.id);
          return result.ok ? ok(result.text) : err(result.error);
        }
        default: {
          // Synchronous (blocking) behavior — unchanged.
          if (!args.goal || !args.successCriteria || !args.resultFormat) {
            return err(
              "Synchronous browser mode requires goal, successCriteria and resultFormat (or use action: \"start\" for async).",
            );
          }
          const sessionId = context?.sessionId ?? `browser-${randomUUID()}`;
          try {
            const result = await runBrowserSubAgent(
              sessionId,
              toBrowserToolInput(args),
              {
                browserConfig: opts.browserConfig,
                defaultModel: opts.defaultModel,
                models: opts.models,
                downloadsBaseDir: opts.downloadsBaseDir,
                browserRunsDir: opts.browserRunsDir,
                toolCallId: context?.toolCallId,
                logger: context?.logger ?? opts.logger,
                onStatus: context?.onStatus,
                parentSignal: context?.signal,
              },
            );
            return result.isError ? err(result.content) : ok(result.content);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return err(`Browser sub-agent failed: ${message}`);
          }
        }
      }
    },
  };
}
