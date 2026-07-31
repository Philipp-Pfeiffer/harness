import path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { createAgent } from "../core/agent.js";
import { resolveModel, resolveModelFromConfig, type ResolvedModel } from "../core/resolveModel.js";
import type { ConfigModel } from "../config.js";
import { prompt } from "../prompts.js";
import type { BrowserConfig } from "./config.js";
import { isOpenRouterPresetRef, parseModelRef, resolveBrowserConfig } from "./config.js";
import { BrowserSubAgentContext } from "./context.js";
import {
  BrowserConnectionError,
  PlaywrightBrowserEngine,
  synthesizeFailureReport,
  type BrowserEngine,
} from "./engine.js";
import { createBrowserSubAgentTools } from "./subAgentTools.js";
import type { BrowserReport, BrowserSessionOptions, BrowserToolInput } from "./types.js";
import { ensureDownloadDir } from "./sandbox.js";
import { BrowserTraceWriter } from "./trace.js";

export interface BrowserRunnerDeps {
  browserConfig?: BrowserConfig;
  defaultModel?: ConfigModel;
  models?: ConfigModel[];
  /** Override engine for tests. */
  engineFactory?: (options: BrowserSessionOptions) => BrowserEngine;
  /** Base directory for downloads/<session-id>/ */
  downloadsBaseDir: string;
  /** Base directory for browser-runs/<session-id>/<run-id>.jsonl traces */
  browserRunsDir: string;
  toolCallId?: string;
  logger?: (msg: string, level?: "warn" | "debug") => void;
  onStatus?: (status: string) => void;
}

function resolveBrowserModel(
  modelRef: string,
  models?: ConfigModel[],
): ResolvedModel {
  if (isOpenRouterPresetRef(modelRef)) {
    const fromConfig = models?.find((m) => m.model === modelRef);
    if (!fromConfig) {
      throw new Error(
        `Unknown OpenRouter preset "${modelRef}". Add it to config.models in $HARNESS_HOME/config.json.`,
      );
    }
    return resolveModelFromConfig(fromConfig);
  }
  const { provider, model: modelId } = parseModelRef(modelRef);
  const fromConfig = models?.find((m) => m.provider === provider && m.model === modelId);
  if (fromConfig) {
    return resolveModelFromConfig(fromConfig);
  }
  return resolveModel(provider, modelId);
}

function buildTaskMessage(input: BrowserToolInput): string {
  const parts = [
    "## Browser Task",
    "",
    `**Goal:** ${input.goal}`,
    `**Success criteria:** ${input.successCriteria}`,
    `**Result format:** ${input.resultFormat}`,
  ];
  if (input.startUrl) {
    parts.push(`**Start URL:** ${input.startUrl}`);
  }
  if (input.context) {
    parts.push("", "**Context:**", input.context);
  }
  parts.push(
    "",
    "Work in cycles: browser_snapshot → act → verify. " +
    "When done or structurally stuck, call submit_report exactly once.",
  );
  return parts.join("\n");
}

function formatReportForMainAgent(
  report: BrowserReport,
  resultFormat: BrowserToolInput["resultFormat"],
): string {
  if (resultFormat === "json") {
    return JSON.stringify(report, null, 2);
  }

  const lines = [
    `# Browser Report`,
    "",
    `**Goal achieved:** ${report.goalAchieved ? "yes" : "no"}`,
    "",
    report.result,
  ];

  if (report.files.length > 0) {
    lines.push("", "## Files", ...report.files.map((f) => `- ${f}`));
  }
  if (report.visitedUrls.length > 0) {
    lines.push("", "## Visited URLs", ...report.visitedUrls.map((u) => `- ${u}`));
  }
  if (report.blockers) {
    lines.push("", "## Blockers", report.blockers);
  }
  if (report.notes) {
    lines.push("", "## Session Notes", report.notes);
  }

  if (resultFormat === "files") {
    lines.push("", "## File paths only", ...report.files.map((f) => f));
  }

  return lines.join("\n");
}

function appendTraceFooter(content: string, tracePath?: string): string {
  if (!tracePath) return content;
  return `${content}\n\n---\n_Browser trace:_ \`${tracePath}\``;
}

export async function runBrowserSubAgent(
  sessionId: string,
  input: BrowserToolInput,
  deps: BrowserRunnerDeps,
): Promise<{ content: string; isError: boolean; report: BrowserReport; tracePath?: string }> {
  const resolved = resolveBrowserConfig(deps.browserConfig, deps.defaultModel);
  const downloadDir = path.join(deps.downloadsBaseDir, sessionId);
  await ensureDownloadDir(downloadDir);

  const trace = await BrowserTraceWriter.create({
    browserRunsDir: deps.browserRunsDir,
    sessionId,
    toolCallId: deps.toolCallId,
    input,
  });

  const sessionOptions: BrowserSessionOptions = {
    cdpUrl: resolved.cdpUrl,
    downloadDir,
    navigationTimeoutMs: resolved.navigationTimeoutMs,
    actionTimeoutMs: resolved.actionTimeoutMs,
    maxTabs: resolved.maxTabs,
    snapshotTokenCap: resolved.snapshotTokenCap,
    maxDownloadBytes: resolved.maxDownloadBytes,
  };

  const engine = deps.engineFactory
    ? deps.engineFactory(sessionOptions)
    : new PlaywrightBrowserEngine({
        mode: resolved.mode,
        cdpUrl: resolved.cdpUrl,
        obscuraPath: resolved.obscuraPath,
        obscuraStartupTimeoutMs: resolved.obscuraStartupTimeoutMs,
      }, sessionOptions);

  const ctx = new BrowserSubAgentContext(sessionId, downloadDir, engine);
  const tools = createBrowserSubAgentTools(ctx, sessionOptions);
  const abortController = new AbortController();
  ctx.setAbortHandler(() => abortController.abort());

  let model: ResolvedModel;
  try {
    model = resolveBrowserModel(resolved.model, deps.models);
  } catch (err) {
    await engine.disconnect().catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    const report = synthesizeFailureReport(`Model resolution failed: ${message}`, [], []);
    await trace.phase("model-resolution-failed");
    await trace.runEnd({ goalAchieved: false, isError: true, failureReason: message });
    return {
      content: appendTraceFooter(formatReportForMainAgent(report, input.resultFormat), trace.tracePath),
      isError: true,
      report,
      tracePath: trace.tracePath,
    };
  }

  const agent = createAgent({
    tools,
    systemPrompt: prompt("browser-agent"),
    model,
    maxIterations: resolved.maxTurns,
    maxTokens: resolved.maxTokens,
    logger: deps.logger,
  });

  const messages: Message[] = [{
    role: "user",
    content: [{ type: "text", text: buildTaskMessage(input) }],
    timestamp: Date.now(),
  } as Message];

  try {
    deps.onStatus?.("browser: connecting");
    await trace.phase("connecting");
    await engine.connect();
    if (input.startUrl) {
      deps.onStatus?.(`browser: navigating to ${input.startUrl}`);
      await trace.phase(`navigating:${input.startUrl}`);
      await engine.navigate(input.startUrl);
    }
  } catch (err) {
    await engine.disconnect().catch(() => undefined);
    const reason = err instanceof BrowserConnectionError
      ? err.message
      : err instanceof Error ? err.message : String(err);
    const report = synthesizeFailureReport(reason, [], []);
    await trace.phase("connection-failed");
    await trace.runEnd({ goalAchieved: false, isError: true, failureReason: reason });
    return {
      content: appendTraceFooter(formatReportForMainAgent(report, input.resultFormat), trace.tracePath),
      isError: true,
      report,
      tracePath: trace.tracePath,
    };
  }

  let runResult;
  try {
    deps.onStatus?.("browser: sub-agent running");
    await trace.phase("sub-agent-running");
    runResult = await agent.run(messages, {
      sessionId,
      signal: abortController.signal,
      onEvent: (event) => {
        if (event.type === "turn_end") {
          void trace.turnEnd();
          deps.onStatus?.(`browser: turn ${event.turn}/${resolved.maxTurns}`);
        } else if (event.type === "tool_call_start") {
          void trace.toolCallStart(event.name, event.args);
          deps.onStatus?.(`browser: ${event.name}`);
        } else if (event.type === "tool_call_done") {
          void trace.toolCallDone(event.name, event.result, false);
        } else if (event.type === "tool_call_error") {
          void trace.toolCallError(event.name, event.error);
        }
      },
    });
  } finally {
    await engine.disconnect().catch(() => undefined);
    await trace.phase("disconnected");
  }

  const visited = engine.getVisitedUrls();
  const notes = [...ctx.notes];
  const usage = runResult.usage;
  const completedTurns = runResult.aborted ? runResult.completedTurns : runResult.turns;
  const toolCallCount = runResult.toolCallCount;

  if (ctx.report) {
    const report = ctx.report;
    await trace.runEnd({
      goalAchieved: report.goalAchieved,
      isError: !report.goalAchieved,
      usage,
      completedTurns,
      toolCallCount,
    });
    return {
      content: appendTraceFooter(formatReportForMainAgent(report, input.resultFormat), trace.tracePath),
      isError: !report.goalAchieved,
      report,
      tracePath: trace.tracePath,
    };
  }

  let failureReason: string;
  if (runResult.aborted && runResult.reason === "maxTurns") {
    failureReason = `Turn budget exhausted (${resolved.maxTurns} turns). Call submit_report earlier when stuck.`;
  } else if (runResult.aborted && runResult.reason === "signal" && ctx.isComplete()) {
    failureReason = "Session ended without report.";
  } else if (runResult.usage.totalTokens > resolved.maxTotalTokens) {
    failureReason = `Token budget exhausted (${runResult.usage.totalTokens} > ${resolved.maxTotalTokens}).`;
  } else {
    failureReason = "Browser sub-agent finished without calling submit_report.";
  }

  const report = synthesizeFailureReport(failureReason, visited, notes);
  if (notes.length > 0) {
    report.notes = notes.join("\n");
  }

  await trace.runEnd({
    goalAchieved: false,
    isError: true,
    usage,
    completedTurns,
    toolCallCount,
    failureReason,
  });

  return {
    content: appendTraceFooter(formatReportForMainAgent(report, input.resultFormat), trace.tracePath),
    isError: true,
    report,
    tracePath: trace.tracePath,
  };
}

