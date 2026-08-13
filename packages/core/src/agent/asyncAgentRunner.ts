import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { createAgent } from "../core/agent.js";
import { processSupervisor, type Task } from "../tools/processSupervisor.js";
import type { Tool } from "../tools/types.js";
import type { ConfigModel } from "../config.js";
import { resolveRoleModel, resolveRolePrompt, resolveRoleTools } from "./subagentRoles.js";

/** Minimal system-event shape shared with the daemon's event bus. */
export interface AgentSystemEvent {
  origin: string;
  text: string;
  /** Optional phone override — delivered to this phone instead of the owner. */
  phoneOverride?: string;
}

export interface AsyncAgentOptions {
  /** System event bus (injected by the daemon). */
  injectSystemEvent?: (event: AgentSystemEvent) => void;
  /** Base directory for sub-agent result artifacts ($HARNESS_STATE/agent-runs). */
  agentRunsDir: string;
  /**
   * Base tool array (or a lazy provider returning it); role tool sets are
   * filtered from it at `start()` time. The provider form is required when
   * the caller can only produce the full tool array AFTER constructing the
   * runner (e.g. the daemon builds tools that depend on the runner itself).
   */
  loadedTools: Tool[] | (() => Tool[]);
  /** Model config for @preset/ refs and fallbacks. */
  models?: ConfigModel[];
  /** Daemon default model (final fallback). */
  defaultModel?: ConfigModel;
  /** Resolves the report target phone for a requester session. */
  resolveReportTarget?: (requesterSessionId: string) => string | undefined;
  logger?: (msg: string, level?: "warn" | "debug") => void;
  /** Max concurrent sub-agent tasks. */
  maxConcurrent?: number;
  /** Per-task timeout. */
  taskTimeoutMs?: number;
}

export type StartAgentResult =
  | { ok: true; id: string; worktree?: string; branch?: string }
  | { ok: false; error: string; runningIds: string[] };

export type AgentStatusResult =
  | { ok: true; status: string; text: string }
  | { ok: false; error: string };

export type StopAgentResult =
  | { ok: true; status: string; text: string }
  | { ok: false; error: string };

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_TASK_TIMEOUT_MS = 60 * 60_000;
const EVENT_ORIGIN = "Subagent";
const WORKTREE_SLUG_MAX = 50;

export interface AsyncAgentRunner {
  start(input: {
    role: string;
    task: string;
    repo?: string;
    model?: string;
    requesterSessionId?: string;
  }): StartAgentResult;
  status(id: string): AgentStatusResult;
  stop(id: string): StopAgentResult;
  listRunningIds(): string[];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Worktree/branch naming for the coder role: `<repo>-coder-<id>` worktree at
 * `<repo>/../<repo>-coder-<id>`, branch `coder/<slug>`. The id is appended so
 * concurrent runs never collide on the branch name.
 */
export function worktreePathsFor(repo: string, id: string, task: string): { worktreePath: string; branch: string } {
  const base = repo.replace(/\/+$/, "");
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, WORKTREE_SLUG_MAX) || "task";
  return {
    worktreePath: `${base}-coder-${id}`,
    branch: `coder/${slug}-${id.slice(0, 8)}`,
  };
}

function createWorktree(repo: string, worktreePath: string, branch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, "worktree", "add", worktreePath, "-b", branch], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git worktree add failed (exit ${code}): ${truncate(stderr, 300)}`));
      }
    });
  });
}

export function createAsyncAgentRunner(opts: AsyncAgentOptions): AsyncAgentRunner {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const taskTimeoutMs = opts.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  function listRunningIds(): string[] {
    return processSupervisor
      .listTasks()
      .running.filter((t) => t.type === "agent")
      .map((t) => t.id);
  }

  function start(input: {
    role: string;
    task: string;
    repo?: string;
    model?: string;
    requesterSessionId?: string;
  }): StartAgentResult {
    const runningIds = listRunningIds();
    if (runningIds.length >= maxConcurrent) {
      return {
        ok: false,
        error: `Max ${maxConcurrent} concurrent sub-agent tasks reached. Running: ${runningIds.join(", ")}`,
        runningIds,
      };
    }

    const id = randomUUID();
    const taskLabel = truncate(input.task, 60);
    const requesterSessionId = input.requesterSessionId;
    const abort = new AbortController();
    let finalized = false;
    let worktreePath: string | undefined;
    let branch: string | undefined;

    const task: Task = {
      id,
      type: "agent",
      status: "running",
      summary: "",
      artifactPaths: [],
      startedAt: new Date(),
      stop: () => {
        abort.abort();
        void finalize("stopped", "Gestoppt");
      },
    };
    processSupervisor.registerTask(task);

    async function finalize(status: "done" | "error" | "stopped", summary: string): Promise<void> {
      if (finalized) return;
      finalized = true;
      task.status = status;
      task.summary = summary;
      task.finishedAt = new Date();

      const resultPath = await writeResultArtifact(task);
      if (resultPath) {
        task.artifactPaths.push(resultPath);
      }

      const reportTarget = requesterSessionId ? opts.resolveReportTarget?.(requesterSessionId) : undefined;
      opts.injectSystemEvent?.({
        origin: EVENT_ORIGIN,
        text: buildEventText(task, taskLabel, worktreePath, branch),
        ...(reportTarget ? { phoneOverride: reportTarget } : {}),
      });
    }

    async function writeResultArtifact(t: Task): Promise<string | null> {
      try {
        const dir = path.join(opts.agentRunsDir, t.id);
        await mkdir(dir, { recursive: true });
        const resultPath = path.join(dir, "result.json");
        await writeFile(
          resultPath,
          JSON.stringify(
            {
              id: t.id,
              role: input.role,
              status: t.status,
              summary: t.summary,
              worktree: worktreePath ?? null,
              branch: branch ?? null,
              startedAt: t.startedAt.toISOString(),
              finishedAt: t.finishedAt?.toISOString() ?? null,
              artifactPaths: t.artifactPaths,
            },
            null,
            2,
          ),
          "utf-8",
        );
        return resultPath;
      } catch {
        return null;
      }
    }

    const timeoutId = setTimeout(() => {
      abort.abort();
      void finalize("error", "timeout");
    }, taskTimeoutMs);
    timeoutId.unref();

    void (async () => {
      try {
        if (input.role === "coder" && input.repo) {
          const w = worktreePathsFor(input.repo, id, input.task);
          await createWorktree(input.repo, w.worktreePath, w.branch);
          worktreePath = w.worktreePath;
          branch = w.branch;
        }
      } catch (err) {
        if (!finalized) {
          await finalize("error", err instanceof Error ? err.message : String(err));
        }
        return;
      }

      try {
        const persona = resolveRolePrompt(input.role);
        // Resolve tools lazily at start time: a provider defers evaluation
        // until now, so callers that populate the full tool array only after
        // constructing the runner (see daemon runtime: loadTools assigns
        // this.allTools AFTER createAsyncAgentRunner) still yield real tools.
        const loadedTools = typeof opts.loadedTools === "function" ? opts.loadedTools() : opts.loadedTools;
        const tools = resolveRoleTools(input.role, loadedTools);
        const model = resolveRoleModel(input.role, input.model, {
          models: opts.models,
          defaultModel: opts.defaultModel,
        });

        const agent = createAgent({
          tools,
          systemPrompt: persona,
          model,
          maxIterations: 100,
          // Orient the subagent's output budget at the model's own limit
          // (e.g. 8192 for the deepseek presets) instead of a hard-coded
          // 4096 that halved it and starved structured tool calls on long
          // briefings + reasoning-heavy models.
          maxTokens: model.maxTokens,
          logger: opts.logger,
        });

        const taskMessage = input.role === "coder" && worktreePath && branch
          ? `Worktree: ${worktreePath} (Branch ${branch}). Arbeite ausschließlich hier.\n\n${input.task}`
          : input.task;

        const messages: Message[] = [{
          role: "user",
          content: [{ type: "text", text: taskMessage }],
          timestamp: Date.now(),
        } as Message];

        const runResult = await agent.run(messages, {
          sessionId: id,
          signal: abort.signal,
          onEvent: (event) => {
            if (event.type === "tool_call_start") {
              task.lastAction = event.name;
            } else if (event.type === "turn_end") {
              task.lastAction = `turn ${event.turn}`;
            }
          },
        });

        if (finalized) return;
        if (runResult.aborted) {
          if (runResult.reason === "signal") {
            // User-initiated stop raced with the finalize above.
            await finalize("stopped", "Abgebrochen");
          } else {
            await finalize("error", `Lauf abgebrochen (${runResult.reason})`);
          }
          return;
        }
        if (runResult.error) {
          // Provider error / crash / turn limit — the run itself reports
          // the failure; mark the task failed, not done.
          await finalize("error", truncate(runResult.error.message, 200));
          return;
        }
        // Guard: a "done" run that emitted an UNPARSED tool call as raw text
        // (the model wrote `<tool_call>`-style markup instead of a structured
        // tool call) did not actually work the task. Without tools the model
        // falls into prose and the runner previously marked that silently done.
        // Surface it as an error so the real symptom is visible.
        if (runResult.toolCallCount === 0 && /<\s*(tool_call|invoke|function_call)\b/i.test(runResult.finalMessage)) {
          await finalize(
            "error",
            truncate(
              `Lauf endete mit ungeparstem Tool-Call statt strukturiertem Aufruf (${runResult.turns} Turn(s)): ${runResult.finalMessage}`,
              200,
            ),
          );
          return;
        }
        await finalize("done", truncate(runResult.finalMessage, 200));
      } catch (err) {
        if (finalized) return;
        await finalize("error", err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return { ok: true, id, worktree: worktreePath, branch };
  }

  function status(id: string): AgentStatusResult {
    const task = processSupervisor.getTask(id);
    if (!task || task.type !== "agent") {
      return { ok: false, error: `Subagent task ${id} not found.` };
    }
    return { ok: true, status: task.status, text: renderStatus(task) };
  }

  function stop(id: string): StopAgentResult {
    const task = processSupervisor.getTask(id);
    if (!task || task.type !== "agent") {
      return { ok: false, error: `Subagent task ${id} not found.` };
    }
    if (task.status === "running") {
      task.stop();
    }
    return { ok: true, status: task.status, text: renderStatus(task) };
  }

  return { start, status, stop, listRunningIds };
}

function buildEventText(task: Task, taskLabel: string, worktreePath?: string, branch?: string): string {
  const outcomeByStatus: Record<string, string> = {
    done: "abgeschlossen",
    error: "fehlgeschlagen",
    stopped: "wurde gestoppt",
  };
  const outcome = outcomeByStatus[task.status] ?? "beendet";
  const detail = task.summary ? ` (${task.summary})` : "";
  const artifacts = task.artifactPaths.map((p) => `\`${p}\``).join(", ");
  const context = worktreePath && branch ? ` Worktree: \`${worktreePath}\` (Branch \`${branch}\`).` : "";
  return `Subagent „${taskLabel}" ${outcome}${detail}. Artefakte: ${artifacts || "keine"}.${context}`;
}

function renderStatus(task: Task): string {
  const runtime = formatAge(task.startedAt, task.finishedAt);
  const lines = [
    `--- subagent task ${task.id} ---`,
    `status: ${task.status}`,
    `runtime: ${runtime}`,
  ];
  if (task.lastAction) lines.push(`last action: ${task.lastAction}`);
  if (task.summary) lines.push(`summary: ${task.summary}`);
  if (task.artifactPaths.length > 0) {
    lines.push("--- artifacts ---", ...task.artifactPaths.map((p) => `- ${p}`));
  }
  return lines.join("\n");
}

function formatAge(startedAt: Date, endedAt?: Date): string {
  const end = endedAt ?? new Date();
  const seconds = Math.floor((end.getTime() - startedAt.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
