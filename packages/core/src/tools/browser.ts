import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { Tool, ToolCallContext } from "./types.js";
import { ok, err } from "./types.js";
import type { BrowserConfig } from "../browser/config.js";
import type { ConfigModel } from "../config.js";
import { runBrowserSubAgent } from "../browser/runner.js";

const BrowserArgs = Type.Object({
  goal: Type.String({
    minLength: 1,
    description:
      "Concrete goal for the browser sub-agent, e.g. \"Find and download the 2025 annual report PDF from example.com\".",
  }),
  successCriteria: Type.String({
    minLength: 1,
    description:
      "Verifiable success condition, e.g. \"PDF saved to downloads and URL of report page recorded\".",
  }),
  resultFormat: Type.Union([
    Type.Literal("markdown"),
    Type.Literal("json"),
    Type.Literal("files"),
  ], {
    description: "How the sub-agent should structure its final report.",
  }),
  startUrl: Type.Optional(Type.String({
    description: "URL to open first. Strongly recommended — avoids vague exploration.",
  })),
  context: Type.Optional(Type.String({
    description:
      "Relevant context: expected consent walls, language, login state, selectors hints, etc.",
  })),
});

const BROWSER_TOOL_DESCRIPTION = `Delegate a web browsing task to a dedicated browser sub-agent.

The sub-agent operates a real browser via CDP (Obscura or Chrome) and returns a structured report.
You do NOT have direct browser tools — this is the only interface.

## How to task well
- State a **concrete goal** and **verifiable success criteria**.
- Specify **resultFormat**: markdown (human-readable), json (structured), or files (paths only).
- Provide a **startUrl** when possible — do not make the agent guess where to begin.
- Add **context** for consent banners, language, expected UI patterns, known blockers.

## Good example
goal: "Download the 2025 annual report PDF"
successCriteria: "PDF file saved in session downloads; report page URL in visitedUrls"
resultFormat: "markdown"
startUrl: "https://investor.example.com/reports"
context: "Cookie banner likely; site is English; report linked from 'Annual Reports' nav"

## Anti-pattern (do NOT do this)
goal: "look at this site"
successCriteria: "tell me what you find"
→ Too vague. The sub-agent will waste turns and may fail structurally.

## Returns
Structured report with goalAchieved, result text, file paths, visited URLs, and optional blockers.`;

export interface CreateBrowserToolOptions {
  browserConfig?: BrowserConfig;
  defaultModel?: ConfigModel;
  models?: ConfigModel[];
  /** Base directory for session downloads (e.g. $HARNESS_STATE/downloads). */
  downloadsBaseDir: string;
  /** Base directory for browser run traces (e.g. $HARNESS_STATE/browser-runs). */
  browserRunsDir: string;
  logger?: (msg: string, level?: "warn" | "debug") => void;
}

export function createBrowserTool(opts: CreateBrowserToolOptions): Tool<typeof BrowserArgs> {
  return {
    name: "browser",
    description: BROWSER_TOOL_DESCRIPTION,
    parameters: BrowserArgs,
    conflictKey: () => "browser-session",
    async execute(args, context?: ToolCallContext) {
      const sessionId = context?.sessionId ?? `browser-${randomUUID()}`;
      try {
        const result = await runBrowserSubAgent(
          sessionId,
          args,
          {
            browserConfig: opts.browserConfig,
            defaultModel: opts.defaultModel,
            models: opts.models,
            downloadsBaseDir: opts.downloadsBaseDir,
            browserRunsDir: opts.browserRunsDir,
            toolCallId: context?.toolCallId,
            logger: context?.logger ?? opts.logger,
            onStatus: context?.onStatus,
          },
        );
        return result.isError ? err(result.content) : ok(result.content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(`Browser sub-agent failed: ${message}`);
      }
    },
  };
}
