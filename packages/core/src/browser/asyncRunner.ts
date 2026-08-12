import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserConfig, ConfigModel } from "../config.js";
import { processSupervisor, type Task } from "../tools/processSupervisor.js";
import { runBrowserSubAgent, type BrowserRunnerDeps } from "./runner.js";
import type { BrowserReport, BrowserToolInput } from "./types.js";

/** Minimal system-event shape shared with the daemon's event bus. */
export interface BrowserSystemEvent {
  origin: string;
  text: string;
}

export interface AsyncBrowserOptions {
  browserConfig?: BrowserConfig;
  defaultModel?: ConfigModel;
  models?: ConfigModel[];
  downloadsBaseDir: string;
  browserRunsDir: string;
  logger?: (msg: string, level?: "warn" | "debug") => void;
  /** System event bus (injected by the daemon). */
  injectSystemEvent?: (event: BrowserSystemEvent) => void;
  /** Max concurrent browser tasks. */
  maxConcurrent?: number;
  /** Per-task timeout. */
  taskTimeoutMs?: number;
}

export type StartBrowserResult =
  | { ok: true; id: string }
  | { ok: false; error: string; runningIds: string[] };

export type BrowserStatusResult =
  | { ok: true; status: string; text: string }
  | { ok: false; error: string };

export type StopBrowserResult =
  | { ok: true; status: string; text: string }
  | { ok: false; error: string };

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000;
const EVENT_ORIGIN = "Browser";

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface AsyncBrowserRunner {
  start(input: BrowserToolInput): StartBrowserResult;
  status(id: string): BrowserStatusResult;
  stop(id: string): StopBrowserResult;
  listRunningIds(): string[];
}

export function createAsyncBrowserRunner(opts: AsyncBrowserOptions): AsyncBrowserRunner {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const taskTimeoutMs = opts.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

  function listRunningIds(): string[] {
    return processSupervisor
      .listTasks()
      .running.filter((t) => t.type === "browser")
      .map((t) => t.id);
  }

  function start(input: BrowserToolInput): StartBrowserResult {
    const runningIds = listRunningIds();
    if (runningIds.length >= maxConcurrent) {
      return {
        ok: false,
        error: `Max ${maxConcurrent} concurrent browser tasks reached. Running: ${runningIds.join(", ")}`,
        runningIds,
      };
    }

    const id = randomUUID();
    const goalLabel = truncate(input.goal, 60);
    const abort = new AbortController();
    let finalized = false;

    const task: Task = {
      id,
      type: "browser",
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

    async function listArtifacts(): Promise<string[]> {
      try {
        const dir = path.join(opts.browserRunsDir, id);
        const entries = await readdir(dir);
        return entries
          .filter((name) => name.endsWith(".jsonl") || name === "result.json")
          .map((name) => path.join(dir, name));
      } catch {
        return [];
      }
    }

    function buildEventText(): string {
      const outcomeByStatus: Record<string, string> = {
        done: "abgeschlossen",
        error: "fehlgeschlagen",
        stopped: "wurde gestoppt",
      };
      const outcome = outcomeByStatus[task.status] ?? "beendet";
      const detail = task.summary ? ` (${task.summary})` : "";
      const artifacts = task.artifactPaths.map((p) => `\`${p}\``).join(", ");
      return (
        `Browser-Task "${goalLabel}" ${outcome}${detail}. ` +
        `Artefakte: ${artifacts || "keine"}.`
      );
    }

    async function finalize(status: "done" | "error" | "stopped", summary: string): Promise<void> {
      if (finalized) return;
      finalized = true;
      task.status = status;
      task.summary = summary;
      task.finishedAt = new Date();

      task.artifactPaths = await listArtifacts();
      const resultPath = await writeResultArtifact(task);
      if (resultPath) {
        task.artifactPaths.push(resultPath);
      }

      opts.injectSystemEvent?.({
        origin: EVENT_ORIGIN,
        text: buildEventText(),
      });
    }

    async function writeResultArtifact(t: Task): Promise<string | null> {
      try {
        const dir = path.join(opts.browserRunsDir, t.id);
        await mkdir(dir, { recursive: true });
        const resultPath = path.join(dir, "result.json");
        await writeFile(
          resultPath,
          JSON.stringify(
            {
              id: t.id,
              status: t.status,
              summary: t.summary,
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
      const deps: BrowserRunnerDeps = {
        browserConfig: opts.browserConfig,
        defaultModel: opts.defaultModel,
        models: opts.models,
        downloadsBaseDir: opts.downloadsBaseDir,
        browserRunsDir: opts.browserRunsDir,
        logger: opts.logger,
        parentSignal: abort.signal,
        onStatus: (status) => {
          task.lastAction = status;
          const prefix = "browser: navigating to ";
          if (status.startsWith(prefix)) {
            task.lastUrl = status.slice(prefix.length);
          }
        },
      };

      try {
        const result = await runBrowserSubAgent(id, input, deps);
        if (finalized) return;

        if (result.isError) {
          await finalize("error", shortFailure(result.report));
        } else {
          await finalize("done", result.report.goalAchieved ? "Ziel erreicht" : "Ziel nicht erreicht");
        }
      } catch (err) {
        if (finalized) return;
        await finalize("error", err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return { ok: true, id };
  }

  function status(id: string): BrowserStatusResult {
    const task = processSupervisor.getTask(id);
    if (!task || task.type !== "browser") {
      return { ok: false, error: `Browser task ${id} not found.` };
    }
    return { ok: true, status: task.status, text: renderStatus(task) };
  }

  function stop(id: string): StopBrowserResult {
    const task = processSupervisor.getTask(id);
    if (!task || task.type !== "browser") {
      return { ok: false, error: `Browser task ${id} not found.` };
    }
    if (task.status === "running") {
      task.stop();
    }
    return { ok: true, status: task.status, text: renderStatus(task) };
  }

  return { start, status, stop, listRunningIds };
}

function renderStatus(task: Task): string {
  const runtime = formatAge(task.startedAt, task.finishedAt);
  const lines = [
    `--- browser task ${task.id} ---`,
    `status: ${task.status}`,
    `runtime: ${runtime}`,
  ];
  if (task.lastUrl) lines.push(`current url: ${task.lastUrl}`);
  if (task.lastAction) lines.push(`last action: ${task.lastAction}`);
  if (task.summary) lines.push(`summary: ${task.summary}`);
  if (task.artifactPaths.length > 0) {
    lines.push("--- artifacts ---", ...task.artifactPaths.map((p) => `- ${p}`));
  }
  return lines.join("\n");
}

function shortFailure(report: BrowserReport): string {
  const reason = report.blockers ?? report.result ?? "unknown error";
  return truncate(reason, 120);
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
