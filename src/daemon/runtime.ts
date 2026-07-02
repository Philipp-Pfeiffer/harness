import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

import type { Message, Model, Api } from "@mariozechner/pi-ai";
import type { Server } from "node:net";

import { resolveHarnessPaths, ensureDirs, type HarnessPaths } from "../config/paths.js";
import { loadConfig, type ConfigModel } from "../cli/config.js";
import { resolveModel, resolveModelFromConfig } from "../core/resolveModel.js";
import { createAgent, type Agent } from "../core/agent.js";
import { loadTools } from "../tools/registry.js";
import { loadCoreMemoryRaw, composeSystemPrompt } from "../core/coreMemory.js";
import { MemoryService } from "../core/memoryService.js";
import { createMetricsRecorder, type MetricsRecorder } from "../core/metrics.js";
import { appendMetric, type DaemonEventType } from "../core/metrics.js";
import { prompt } from "../prompts.js";
import {
  createSession,
  recordTurn,
  type Session,
} from "../core/session.js";
import { ensureInbox } from "../core/memoryFolders.js";

import { DaemonLogger } from "./logger.js";
import { startIpcServer, stopIpcServer } from "./ipc.js";
import {
  writePidFile,
  removePidFile,
  cleanupStalePidFile,
} from "./process.js";
import type {
  IpcRequest,
  IpcResponse,
  DaemonStatusInfo,
  DaemonConfig,
  GatewayAdapter,
} from "./types.js";
import { DEFAULT_DAEMON_CONFIG } from "./types.js";

/**
 * Heartbeat hook — periodic self-check interface.
 *
 * Implementations register here; the daemon calls `check()` on the
 * configured interval. The actual scheduler/heartbeat implementation
 * comes with the cron/scheduler feature — this is the mounting point.
 */
export interface HeartbeatHook {
  /** Unique name for this heartbeat check. */
  readonly name: string;
  /** Returns true if healthy, false otherwise. */
  check(): Promise<boolean>;
}

/**
 * Ring buffer for recent errors, surfaced in /status.
 */
class ErrorRingBuffer {
  private readonly bufferSize = 10;
  private errors: string[] = [];

  push(msg: string): void {
    this.errors.push(`${new Date().toISOString()} ${msg}`);
    if (this.errors.length > this.bufferSize) {
      this.errors.shift();
    }
  }

  snapshot(): string[] {
    return [...this.errors];
  }

  clear(): void {
    this.errors = [];
  }
}

export class DaemonRuntime {
  private readonly paths: HarnessPaths;
  private readonly logger: DaemonLogger;
  private config: DaemonConfig;
  private agent: Agent | null = null;
  private model: Model<Api> | null = null;
  private configDefaultModel: ConfigModel | undefined;
  private memoryService: MemoryService | null = null;
  private metricsRecorder: MetricsRecorder;
  private session: Session | null = null;
  private ipcServer: Server | null = null;
  private readonly startTime: string;
  private readonly startMs: number;
  private turnsCompleted = 0;
  private readonly errorBuffer = new ErrorRingBuffer();
  private readonly gateways = new Map<string, GatewayAdapter>();
  private readonly heartbeatHooks: HeartbeatHook[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(opts?: { config?: Partial<DaemonConfig> }) {
    this.paths = resolveHarnessPaths();
    this.config = { ...DEFAULT_DAEMON_CONFIG, ...opts?.config };
    this.logger = new DaemonLogger({
      logDir: this.paths.logs,
      retentionDays: this.config.logRetentionDays,
    });
    this.metricsRecorder = createMetricsRecorder({});
    this.startTime = new Date().toISOString();
    this.startMs = Date.now();
  }

  async start(): Promise<void> {
    await this.logger.init();
    const log = this.logger.child("runtime");
    log.info("daemon starting", { pid: process.pid, state: this.paths.state });

    // Clean up stale PID file from a previous crash
    const wasStale = await cleanupStalePidFile(this.paths.pidFile);
    if (wasStale) {
      log.warn("stale PID file detected and removed — crash-restart scenario", {
        pidFile: this.paths.pidFile,
      });
      await this.recordDaemonMetric("daemon_crash_restart");
    }

    // Write PID file
    await writePidFile(this.paths.pidFile, process.pid, this.startTime);

    // Ensure directories
    await ensureDirs(this.paths);
    await ensureInbox(this.paths.inbox);

    // Init memory service
    const dbPath = resolve(this.paths.index, "index.sqlite");
    await mkdir(this.paths.index, { recursive: true });
    this.memoryService = new MemoryService({
      memoryPath: this.paths.memory,
      sourcesPath: this.paths.sources,
      dbPath,
    });
    await this.memoryService.init();

    // Load config
    await this.loadDaemonConfig();

    // Init agent
    await this.initAgent();

    // Create session
    await this.initSession();

    // Start IPC server
    this.ipcServer = await startIpcServer(this.paths.socketFile, (req) =>
      this.handleIpcRequest(req),
    );
    log.info("IPC server listening", { socket: this.paths.socketFile });

    // Start heartbeat if configured
    if (this.config.heartbeatIntervalSec > 0) {
      this.startHeartbeat();
    }

    // Record start metric
    await this.recordDaemonMetric("daemon_start");
    log.info("daemon started", { uptime: 0 });

    // Signal handlers
    process.on("SIGTERM", () => void this.shutdown("SIGTERM"));
    process.on("SIGINT", () => void this.shutdown("SIGINT"));
  }

  async shutdown(signal?: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const log = this.logger.child("runtime");
    log.info("daemon shutting down", { signal });

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Stop gateways
    for (const [name, gw] of this.gateways) {
      try {
        await gw.stop();
        log.info("gateway stopped", { name });
      } catch (err) {
        log.error("gateway stop failed", {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Stop IPC server
    if (this.ipcServer) {
      await stopIpcServer(this.ipcServer, this.paths.socketFile);
      this.ipcServer = null;
    }

    // End session
    if (this.session) {
      try {
        const { endSession } = await import("../core/session.js");
        this.session = await endSession(this.session, this.paths);
      } catch (err) {
        log.error("failed to end session", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Shutdown memory service
    if (this.memoryService) {
      await this.memoryService.shutdown();
    }

    // Remove PID file
    await removePidFile(this.paths.pidFile);

    // Record stop metric
    await this.recordDaemonMetric("daemon_stop");
    log.info("daemon stopped");

    process.exit(0);
  }

  /**
   * Reloads the daemon config without restarting.
   *
   * Hot-reloadable: memory.maxHints, logRetentionDays, heartbeatIntervalSec,
   *                 skills list (if the tools support it).
   * Requires restart: defaultModel, providers, gateways (add/remove).
   */
  async reloadConfig(): Promise<{ ok: boolean; message: string }> {
    const log = this.logger.child("config");
    log.info("reloading config");

    try {
      await this.loadDaemonConfig();

      // Re-apply hot-reloadable settings
      if (this.memoryService && this.config.memory.ambientHints === false) {
        log.info("ambient hints disabled — will take effect on next turn");
      }

      // Adjust heartbeat
      if (this.heartbeatTimer && this.config.heartbeatIntervalSec === 0) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        log.info("heartbeat disabled");
      } else if (!this.heartbeatTimer && this.config.heartbeatIntervalSec > 0) {
        this.startHeartbeat();
        log.info("heartbeat enabled", {
          interval: this.config.heartbeatIntervalSec,
        });
      }

      await this.recordDaemonMetric("config_reload");
      log.info("config reloaded successfully");
      return { ok: true, message: "Config reloaded. Model/provider/gateway changes require restart." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("config reload failed", { error: msg });
      return { ok: false, message: msg };
    }
  }

  /**
   * Registers a gateway adapter. The daemon calls start() on it.
   * (Not used yet — WhatsApp adapter docks here in the next goal.)
   */
  async registerGateway(adapter: GatewayAdapter): Promise<void> {
    const log = this.logger.child("gateway");
    this.gateways.set(adapter.name, adapter);
    await adapter.start();
    log.info("gateway started", { name: adapter.name });
  }

  /**
   * Registers a heartbeat hook for periodic health checks.
   * The scheduler implementation comes later; this is the mounting point.
   */
  registerHeartbeat(hook: HeartbeatHook): void {
    this.heartbeatHooks.push(hook);
    this.logger.info("heartbeat hook registered", { name: hook.name });
  }

  /**
   * Returns the current daemon status for /status and daemon status commands.
   */
  getStatus(): DaemonStatusInfo {
    return {
      pid: process.pid,
      uptime: Math.floor((Date.now() - this.startMs) / 1000),
      startTime: this.startTime,
      model: this.model?.name ?? "unknown",
      gateways:
        this.gateways.size > 0
          ? [...this.gateways.keys()].join(", ")
          : "none configured",
      lastErrors: this.errorBuffer.snapshot(),
      sessionsActive: this.session ? 1 : 0,
      turnsCompleted: this.turnsCompleted,
    };
  }

  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startMs) / 1000);
  }

  // ─── IPC Handler ───

  private async handleIpcRequest(req: IpcRequest): Promise<IpcResponse> {
    switch (req.type) {
      case "ping":
        return { type: "pong", uptime: this.getUptimeSeconds(), pid: process.pid };

      case "status":
        return { type: "status", daemon: this.getStatus() };

      case "submit-turn": {
        const messages = req.messages as Message[];
        if (!this.agent || !this.session) {
          return {
            type: "error",
            message: "Daemon not fully initialized (agent or session missing)",
          };
        }
        try {
          const controller = new AbortController();
          const result = await this.agent.run(messages, {
            signal: controller.signal,
            metricsRecorder: this.metricsRecorder,
            memoryBackend: this.memoryService?.getBackend(),
          });
          this.turnsCompleted++;

          // Record the turn in the session transcript
          const finalMessage = result.aborted
            ? "Aborted"
            : result.finalMessage;
          const turn = {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: finalMessage,
            userContent:
              messages.find((m) => m.role === "user")?.content?.toString() ??
              "",
            tokens: {
              input: result.usage.inputTokens,
              output: result.usage.outputTokens,
              total: result.usage.totalTokens,
              cacheRead: result.usage.cacheRead,
              cacheWrite: result.usage.cacheWrite,
            },
            timing: {
              startedAt: this.startTime,
              latencyMs: 0,
            },
            model: this.model?.name ?? "unknown",
            timestamp: new Date().toISOString(),
            messages,
          };
          this.session = await recordTurn(this.session, turn, this.paths);

          return {
            type: "turn-accepted",
            info: `Turn completed: ${result.aborted ? "aborted" : "ok"}, ${result.aborted ? result.completedTurns : result.turns} turns, ${result.usage.totalTokens} tokens`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.errorBuffer.push(msg);
          return { type: "error", message: msg };
        }
      }

      case "reload-config": {
        const result = await this.reloadConfig();
        return { type: "config-reloaded", ok: result.ok, message: result.message };
      }

      case "shutdown": {
        void this.shutdown("ipc");
        return { type: "shutting-down" };
      }

      default:
        return { type: "error", message: `Unknown IPC request type` };
    }
  }

  // ─── Initialization ───

  private async loadDaemonConfig(): Promise<void> {
    const result = await loadConfig({ harnessHome: this.paths.home });
    this.configDefaultModel = result.defaultModel;

    // Load daemon-specific config from config.json if present
    // (The existing config format is extended with an optional "daemon" key)
    try {
      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(this.paths.config, "utf-8"),
      );
      const parsed = JSON.parse(raw) as { daemon?: Partial<DaemonConfig> };
      if (parsed.daemon) {
        this.config = { ...DEFAULT_DAEMON_CONFIG, ...parsed.daemon };
      }
    } catch {
      // No daemon config in config.json — keep defaults
    }
  }

  private async initAgent(): Promise<void> {
    const log = this.logger.child("agent");

    // Resolve model
    if (this.configDefaultModel) {
      try {
        this.model = resolveModelFromConfig(this.configDefaultModel);
      } catch (err) {
        log.warn("failed to resolve default model from config, using fallback", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!this.model) {
      this.model = resolveModel("minimax", "MiniMax-M2.7");
    }

    // Load tools
    const tools = loadTools(this.memoryService?.getBackend());

    // Create agent
    this.agent = createAgent({
      tools,
      model: this.model,
    });

    // Load system prompt
    const coreMemory = await loadCoreMemoryRaw(this.paths.core);
    const basePrompt = prompt("system-prompt", { inboxPath: this.paths.inbox });
    const composed = composeSystemPrompt(basePrompt, coreMemory);
    this.agent.setSystemPrompt(composed);

    log.info("agent initialized", { model: this.model.name });
  }

  private async initSession(): Promise<void> {
    const log = this.logger.child("session");
    try {
      this.session = await createSession(this.paths, {
        model: this.model?.name ?? "unknown",
        title: "Daemon Session",
      });
      this.metricsRecorder = createMetricsRecorder({
        sessionId: this.session.id,
      });
      log.info("session created", { id: this.session.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("failed to create session", { error: msg });
      this.errorBuffer.push(msg);
    }
  }

  private startHeartbeat(): void {
    const intervalMs = this.config.heartbeatIntervalSec * 1000;
    const log = this.logger.child("heartbeat");

    this.heartbeatTimer = setInterval(async () => {
      for (const hook of this.heartbeatHooks) {
        try {
          const ok = await hook.check();
          if (!ok) {
            log.warn("heartbeat check failed", { name: hook.name });
          }
        } catch (err) {
          log.error("heartbeat check error", {
            name: hook.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }, intervalMs);
  }

  private async recordDaemonMetric(
    eventType: DaemonEventType,
  ): Promise<void> {
    await appendMetric(
      {
        ts: new Date().toISOString(),
        type: "daemon",
        event: eventType,
        pid: process.pid,
        uptime: this.getUptimeSeconds(),
      },
      this.paths.metrics,
    );
  }
}
