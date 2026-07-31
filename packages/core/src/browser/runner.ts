import path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { createAgent } from "../core/agent.js";
import { resolveModel, resolveModelFromConfig, type ResolvedModel } from "../core/resolveModel.js";
import type { ConfigModel } from "../config.js";
import { prompt } from "../prompts.js";
import type { BrowserConfig } from "./config.js";
import { parseModelRef, resolveBrowserConfig } from "./config.js";
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

export interface BrowserRunnerDeps {
  browserConfig?: BrowserConfig;
  defaultModel?: ConfigModel;
  models?: ConfigModel[];
  /** Override engine for tests. */
  engineFactory?: (options: BrowserSessionOptions) => BrowserEngine;
  /** Base directory for downloads/<session-id>/ */
  downloadsBaseDir: string;
  logger?: (msg: string, level?: "warn" | "debug") => void;
}

function resolveBrowserModel(
  modelRef: string,
  models?: ConfigModel[],
): ResolvedModel {
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

export async function runBrowserSubAgent(
  sessionId: string,
  input: BrowserToolInput,
  deps: BrowserRunnerDeps,
): Promise<{ content: string; isError: boolean; report: BrowserReport }> {
  const resolved = resolveBrowserConfig(deps.browserConfig, deps.defaultModel);
  const downloadDir = path.join(deps.downloadsBaseDir, sessionId);
  await ensureDownloadDir(downloadDir);

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
    : new PlaywrightBrowserEngine(resolved.cdpUrl, sessionOptions);

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
    return {
      content: formatReportForMainAgent(report, input.resultFormat),
      isError: true,
      report,
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
    await engine.connect();
    if (input.startUrl) {
      await engine.navigate(input.startUrl);
    }
  } catch (err) {
    await engine.disconnect().catch(() => undefined);
    const reason = err instanceof BrowserConnectionError
      ? err.message
      : err instanceof Error ? err.message : String(err);
    const report = synthesizeFailureReport(reason, [], []);
    return {
      content: formatReportForMainAgent(report, input.resultFormat),
      isError: true,
      report,
    };
  }

  let runResult;
  try {
    runResult = await agent.run(messages, {
      sessionId,
      signal: abortController.signal,
    });
  } finally {
    await engine.disconnect().catch(() => undefined);
  }

  const visited = engine.getVisitedUrls();
  const notes = [...ctx.notes];

  if (ctx.report) {
    const report = ctx.report;
    return {
      content: formatReportForMainAgent(report, input.resultFormat),
      isError: !report.goalAchieved,
      report,
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

  return {
    content: formatReportForMainAgent(report, input.resultFormat),
    isError: true,
    report,
  };
}

