import { resolve, join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Message, Model, Api } from "@mariozechner/pi-ai";
import type { Server } from "node:net";

import {
  resolveHarnessPaths,
  ensureDirs,
  loadConfig,
  resolveModel,
  resolveModelFromConfig,
  createAgent,
  createMailbox,
  loadTools,
  createMetricsRecorder,
  appendMetric,
  prompt,
  DEFAULT_COMPACTION_THRESHOLD,
  compactSession,
  estimateTokens,
  loadSkills,
  validateRequires,
  readTelemetry,
  telemetryPathFor,
  buildHotSet,
  renderHotSet,
  type HarnessPaths,
  type ConfigModel,
  type Agent,
  type MetricsRecorder,
  type DaemonEventType,
  type Mailbox,
  type ResolvedModel,
  type SkillRecord,
} from "@harness/core";
import { loadCoreMemoryRaw, composeSystemPrompt } from "../core/coreMemory.js";
import { MemoryService } from "../core/memoryService.js";
import {
  createSession,
  recordTurn,
  endSession,
  suspendSession,
  loadSession,
  turnsToMessages,
  listSessions,
  countTurnsInTranscript,
  markActiveSessionsIdle,
  extractToolData,
  type Session,
} from "../core/session.js";
import { ensureInbox } from "../core/memoryFolders.js";

import { DaemonLogger } from "./logger.js";
import { startIpcServer, stopIpcServer } from "./ipc.js";
import { CronScheduler } from "./scheduler.js";
import type { CronJob } from "./jobs.js";
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
  SessionOrigin,
  SessionSummary,
  TurnStreamEvent,
} from "./types.js";
import { DEFAULT_DAEMON_CONFIG } from "./types.js";

/**
 * Heartbeat hook — periodic self-check interface.
 *
 * Implementations register here; the daemon calls `check()` on the
 * configured interval. (Cron jobs are a separate mechanism — see
 * scheduler.ts; heartbeat hooks are health checks, not scheduled work.)
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

/**
 * In-memory session entry. Created on-demand, holds the live message
 * context so the agent can continue the conversation.
 */
interface SessionEntry {
  session: Session;
  messages: Message[];
  turnsCompleted: number;
  metricsRecorder: MetricsRecorder;
  origin: SessionOrigin;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  /** Mailbox for steering messages that arrive while a turn is running. */
  mailbox: Mailbox;
  /** Turn queue: serializes turns per session. A second submit-turn on the
   *  same session waits for the first to complete instead of racing on
   *  entry.messages in-place. Messages arriving mid-turn go to the mailbox. */
  turnQueue: Promise<unknown>;
}

export class DaemonRuntime {
  private readonly paths: HarnessPaths;
  private readonly logger: DaemonLogger;
  private config: DaemonConfig;
  private agent: Agent | null = null;
  private model: Model<Api> | null = null;
  private configDefaultModel: ConfigModel | undefined;
  private memoryService: MemoryService | null = null;
  private readonly sessions = new Map<string, SessionEntry>();
  private ipcServer: Server | null = null;
  private readonly startTime: string;
  private readonly startMs: number;
  private readonly errorBuffer = new ErrorRingBuffer();
  private readonly gateways = new Map<string, GatewayAdapter>();
  private readonly heartbeatHooks: HeartbeatHook[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private scheduler: CronScheduler | null = null;
  private skillRecords: SkillRecord[] = [];
  private shuttingDown = false;

  constructor(opts?: { config?: Partial<DaemonConfig> }) {
    this.paths = resolveHarnessPaths();
    this.config = { ...DEFAULT_DAEMON_CONFIG, ...opts?.config };
    this.logger = new DaemonLogger({
      logDir: this.paths.logs,
      retentionDays: this.config.logRetentionDays,
    });
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

    // Mark orphaned "active" sessions as "idle" — only in-memory sessions
    // are "active", and this daemon starts with an empty session map.
    const idleCount = await markActiveSessionsIdle(this.paths);
    if (idleCount > 0) {
      log.info("marked orphaned active sessions as idle", { count: idleCount });
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

    // Sessions are created on-demand — no initSession() here.

    // Start IPC server
    this.ipcServer = await startIpcServer(this.paths.socketFile, (req, send) =>
      this.handleIpcRequest(req, send),
    );
    log.info("IPC server listening", { socket: this.paths.socketFile });

    // Start heartbeat if configured
    if (this.config.heartbeatIntervalSec > 0) {
      this.startHeartbeat();
    }

    // Start cron scheduler (job files in $HARNESS_STATE/jobs/).
    // Scheduler failure must not prevent daemon startup.
    try {
      this.scheduler = new CronScheduler({
        jobsDir: this.paths.jobs,
        logger: this.logger.child("cron"),
        runAgentJob: async (job) => {
          await this.runCronAgentJob(job);
        },
        scriptCtx: {
          paths: this.paths,
          logger: this.logger.child("cron-script"),
          retentionDays: this.config.logRetentionDays,
        },
      });
      await this.scheduler.start();
    } catch (err) {
      this.scheduler = null;
      log.error("cron scheduler failed to start — continuing without it", {
        error: err instanceof Error ? err.message : String(err),
      });
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

    // Stop cron scheduler (running jobs finish, pending jitter is dropped)
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
      log.info("cron scheduler stopped");
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

    // Suspend all active sessions — they are resumable, not ended.
    for (const [id, entry] of this.sessions) {
      try {
        entry.session = await suspendSession(entry.session, this.paths);
        log.info("session suspended", { id });
      } catch (err) {
        log.error("failed to suspend session", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.sessions.clear();

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
   * Executes an agent-type cron job: creates a fresh session with origin
   * "cron" via the session registry and runs the job body as its first
   * turn. Returns the new session id. Throws on failure — the scheduler
   * catches and logs it.
   */
  async runCronAgentJob(job: CronJob): Promise<string> {
    const created = await this.handleIpcRequest({
      type: "create-session",
      origin: "cron",
      title: `cron: ${job.name}`,
    });
    if (created.type !== "session-created") {
      throw new Error(
        created.type === "error"
          ? created.message
          : `unexpected create-session response: ${created.type}`,
      );
    }
    const resp = await this.handleIpcRequest({
      type: "submit-turn",
      text: job.body,
      sessionId: created.sessionId,
    });
    if (resp.type === "error") {
      throw new Error(resp.message);
    }
    return created.sessionId;
  }

  /**
   * Returns the current daemon status for /status and daemon status commands.
   */
  getStatus(): DaemonStatusInfo {
    let totalTurns = 0;
    for (const entry of this.sessions.values()) {
      totalTurns += entry.turnsCompleted;
    }
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
      sessionsActive: this.sessions.size,
      turnsCompleted: totalTurns,
    };
  }

  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startMs) / 1000);
  }

  /** Returns the IPC socket path (for startup logging). */
  getSocketPath(): string {
    return this.paths.socketFile;
  }

  // ─── IPC Handler ───

  private async handleIpcRequest(
    req: IpcRequest,
    send?: (resp: IpcResponse) => void,
  ): Promise<IpcResponse> {
    switch (req.type) {
      case "ping":
        return { type: "pong", uptime: this.getUptimeSeconds(), pid: process.pid };

      case "status":
        return { type: "status", daemon: this.getStatus() };

      case "create-session": {
        const origin: SessionOrigin = req.origin ?? "api";
        const title = req.title ?? `${origin} session`;
        const model = req.model ?? this.model?.name ?? "unknown";
        try {
          const session = await createSession(this.paths, { model, title });
          const entry = this.createSessionEntry(session, origin, title);
          this.sessions.set(session.id, entry);
          const log = this.logger.child("session");
          log.info("session created", { id: session.id, origin });
          return {
            type: "session-created",
            sessionId: session.id,
            origin,
            createdAt: entry.createdAt,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.errorBuffer.push(msg);
          return { type: "error", message: msg };
        }
      }

      case "list-sessions": {
        try {
          const persisted = await listSessions(this.paths);
          const summaries: SessionSummary[] = [];

          // In-memory sessions first
          for (const [id, entry] of this.sessions) {
            summaries.push({
              sessionId: id,
              title: entry.title,
              origin: entry.origin,
              status: "active",
              createdAt: entry.createdAt,
              lastActiveAt: entry.lastActiveAt,
              model: entry.session.model,
              turnsCompleted: entry.turnsCompleted,
              inMemory: true,
            });
          }

          // Persisted sessions not in memory
          const inMemoryIds = new Set(this.sessions.keys());
          for (const idx of persisted) {
            if (inMemoryIds.has(idx.sessionId)) continue;
            const turnCount = await countTurnsInTranscript(idx.sessionId, this.paths);
            summaries.push({
              sessionId: idx.sessionId,
              title: idx.title,
              origin: "api", // Origin not persisted yet — default
              status: idx.status,
              createdAt: idx.created,
              lastActiveAt: idx.lastActivity,
              model: idx.model,
              turnsCompleted: turnCount,
              inMemory: false,
            });
          }

          // Sort by lastActiveAt descending
          summaries.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

          return { type: "sessions-listed", sessions: summaries };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { type: "error", message: msg };
        }
      }

      case "resume-session": {
        const sessionId = req.sessionId;
        if (this.sessions.has(sessionId)) {
          const entry = this.sessions.get(sessionId)!;
          return {
            type: "session-resumed",
            sessionId,
            messageCount: entry.messages.length,
          };
        }
        try {
          const loaded = await loadSession(sessionId, this.paths);
          if (!loaded) {
            return { type: "error", message: `Session not found: ${sessionId}` };
          }
          if (loaded.session.status === "ended") {
            return {
              type: "error",
              message: `Session ${sessionId} is ended and cannot be resumed.`,
              sessionId,
            };
          }
          const entry = this.createSessionEntry(
            loaded.session,
            "api",
            loaded.session.title,
          );
          entry.session = { ...entry.session, status: "active" };
          entry.messages = loaded.turns.length > 0
            ? turnsToMessages(loaded.turns)
            : [];
          this.sessions.set(sessionId, entry);
          const log = this.logger.child("session");
          log.info("session resumed", { id: sessionId, messages: entry.messages.length });
          return {
            type: "session-resumed",
            sessionId,
            messageCount: entry.messages.length,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.errorBuffer.push(msg);
          return { type: "error", message: msg };
        }
      }

      case "submit-turn": {
        if (!this.agent) {
          return {
            type: "error",
            message: "Daemon not fully initialized (agent missing)",
          };
        }

        try {
          // Daemon-side slash command interpretation.
          // These commands are handled here (not in the client) so they work
          // identically across all gateways (TUI, WhatsApp, etc.).
          // /sessions and /resume <id> work without an active session.
          // /new and /end require a session (resolved or created below).
          if (req.text) {
            // Handle session-listing and resume commands that don't need
            // an existing session first.
            const trimmed = req.text.trim();
            if (trimmed === "/sessions" || trimmed.match(/^\/resume\s+\S+/)) {
              const cmdResult = await this.tryHandleSlashCommand(req.text, req.sessionId ?? "", send);
              if (cmdResult) return cmdResult;
            }
          }

          // Resolve or create session
          let entry: SessionEntry;
          let sessionId: string;

          if (req.sessionId) {
            // Explicit session ID — resolve from memory or resume from disk
            if (this.sessions.has(req.sessionId)) {
              entry = this.sessions.get(req.sessionId)!;
            } else {
              const loaded = await loadSession(req.sessionId, this.paths);
              if (!loaded) {
                return {
                  type: "error",
                  message: `Session not found: ${req.sessionId}`,
                  sessionId: req.sessionId,
                };
              }
              if (loaded.session.status === "ended") {
                return {
                  type: "error",
                  message: `Session ${req.sessionId} is ended and cannot be resumed.`,
                  sessionId: req.sessionId,
                };
              }
              entry = this.createSessionEntry(
                loaded.session,
                "api",
                loaded.session.title,
              );
              entry.session = { ...entry.session, status: "active" };
              entry.messages = loaded.turns.length > 0
                ? turnsToMessages(loaded.turns)
                : [];
              this.sessions.set(req.sessionId, entry);
            }
            sessionId = req.sessionId;
          } else {
            // No session ID — create a new session on-demand
            const session = await createSession(this.paths, {
              model: this.model?.name ?? "unknown",
              title: "IPC Session",
            });
            entry = this.createSessionEntry(session, "api", "IPC Session");
            this.sessions.set(session.id, entry);
            sessionId = session.id;
          }

          // Handle session-scoped slash commands (/new, /end) now that we
          // have a resolved session.
          if (req.text) {
            const cmdResult = await this.tryHandleSlashCommand(req.text, sessionId, send);
            if (cmdResult) return cmdResult;
          }

          // Validate input up-front. The user message is NOT appended here —
          // that happens inside the queued turn body below, so that
          // entry.messages is only mutated while holding the session's
          // turn queue.
          if (!req.text && !req.messages) {
            return {
              type: "error",
              message: "submit-turn requires either 'text' or 'messages'",
              sessionId,
            };
          }

          // ─── Turn Queue: serialize turns per session ───
          //
          // The turn body is a promise PRODUCER passed to
          // entry.turnQueue.then(...) — not an immediately-invoked IIFE —
          // so the user-message push and agent.run() only start once the
          // previous turn on this session has fully settled. Two parallel
          // submit-turns on the same session therefore run strictly serial
          // on entry.messages; different sessions have separate queues and
          // are not blocked by each other.
          //
          // A failed turn must not tear the queue: entry.turnQueue always
          // stores turnPromise.catch(() => undefined), so the next queued
          // turn runs even when this one rejected.
          const agent = this.agent;
          const runQueuedTurn = async (): Promise<IpcResponse> => {
            const turnStartedAt = new Date().toISOString();
            const turnStartedMs = Date.now();

            // Build message array — inside the queued body, while holding
            // the queue. A queued turn never sees a later turn's user
            // message: no interleaves on entry.messages.
            let messages: Message[];
            const messagesBeforeTurn = req.text
              ? entry.messages.length
              : 0;
            if (req.text) {
              // New-style: daemon manages context
              messages = entry.messages;
              messages.push({
                role: "user",
                content: req.text,
                timestamp: Date.now(),
              } as Message);
            } else {
              // Old-style: caller provides full message array
              messages = req.messages as Message[];
            }

            const result = await agent.run(messages, {
              metricsRecorder: entry.metricsRecorder,
              memoryBackend: this.memoryService?.getBackend(),
              compaction: {
                paths: this.paths,
                sessionId,
                threshold: DEFAULT_COMPACTION_THRESHOLD,
              },
              mailbox: entry.mailbox,
              onEvent: (event) => {
                if (!send) return;
                let streamEvent: TurnStreamEvent | null = null;
                switch (event.type) {
                  case "token":
                    streamEvent = { type: "token", text: event.text };
                    break;
                  case "thinking":
                    streamEvent = { type: "thinking", text: event.text };
                    break;
                  case "tool_call_start":
                    streamEvent = { type: "tool_call_start", name: event.name, args: event.args };
                    break;
                  case "tool_call_done":
                    streamEvent = { type: "tool_call_done", name: event.name, result: event.result };
                    break;
                  case "tool_call_error":
                    streamEvent = { type: "tool_call_error", name: event.name, error: event.error };
                    break;
                  default:
                    // Other event types (turn_end, usage) — not streamed to client
                    break;
                }
                if (streamEvent) {
                  send({ type: "turn-event", sessionId, event: streamEvent });
                }
              },
            });

            entry.turnsCompleted++;
            entry.lastActiveAt = new Date().toISOString();

            // If daemon managed context (new-style), the agent has mutated
            // `messages` in place — which is `entry.messages`. Nothing to do.
            // If old-style, we need to sync messages back to the entry
            // in case the caller will send `text` on a later turn.
            if (req.messages && !req.text) {
              entry.messages = messages;
            }

            // Record the turn in the session transcript
            const finalMessage = result.aborted
              ? "Aborted"
              : result.finalMessage;
            const turnSlice = messages.slice(messagesBeforeTurn);
            const { tool_calls, tool_results } = extractToolData(turnSlice);
            const turn = {
              id: crypto.randomUUID(),
              role: "assistant" as const,
              content: finalMessage,
              userContent:
                req.text ??
                (messages.find((m) => m.role === "user")?.content?.toString() ??
                  ""),
              tool_calls,
              tool_results,
              tokens: {
                input: result.usage.inputTokens,
                output: result.usage.outputTokens,
                total: result.usage.totalTokens,
                cacheRead: result.usage.cacheRead,
                cacheWrite: result.usage.cacheWrite,
              },
              timing: {
                startedAt: turnStartedAt,
                latencyMs: Date.now() - turnStartedMs,
              },
              model: this.model?.name ?? "unknown",
              timestamp: new Date().toISOString(),
              messages: turnSlice,
            };
            entry.session = await recordTurn(entry.session, turn, this.paths);

            return {
              type: "turn-complete" as const,
              sessionId,
              finalResponse: finalMessage,
              info: `Turn completed: ${result.aborted ? "aborted" : "ok"}, ${result.aborted ? result.completedTurns : result.turns} turns, ${result.usage.totalTokens} tokens`,
              turnsCompleted: entry.turnsCompleted,
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                totalTokens: result.usage.totalTokens,
                cacheRead: result.usage.cacheRead,
                cacheWrite: result.usage.cacheWrite,
              },
            };
          };

          // Chain the producer onto the queue: this turn starts only after
          // the previous turn on this session settled (either outcome).
          // The stored queue promise never stays rejected, so a failed turn
          // does not tear the queue for the next submit.
          const turnPromise = entry.turnQueue.then(runQueuedTurn, runQueuedTurn);
          entry.turnQueue = turnPromise.catch(() => undefined);

          return await turnPromise;
        } catch (err) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          const msg = this.enhanceAuthError(rawMsg);
          this.errorBuffer.push(msg);
          return {
            type: "error",
            message: msg,
            sessionId: req.sessionId,
          };
        }
      }

      case "end-session": {
        const sessionId = req.sessionId;
        try {
          // If session is in memory, end it and remove from active map
          const entry = this.sessions.get(sessionId);
          if (entry) {
            entry.session = await endSession(entry.session, this.paths);
            this.sessions.delete(sessionId);
            const log = this.logger.child("session");
            log.info("session ended via IPC", { id: sessionId });
          } else {
            // Session not in memory — end it on disk directly
            const loaded = await loadSession(sessionId, this.paths);
            if (loaded) {
              await endSession(loaded.session, this.paths);
              const log = this.logger.child("session");
              log.info("session ended via IPC (disk-only)", { id: sessionId });
            } else {
              return { type: "error", message: `Session not found: ${sessionId}`, sessionId };
            }
          }
          return { type: "session-ended", sessionId };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.errorBuffer.push(msg);
          return { type: "error", message: msg, sessionId };
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
    // Merge: constructor overrides take precedence over config.json daemon key,
    // which in turn takes precedence over DEFAULT_DAEMON_CONFIG.
    try {
      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(this.paths.config, "utf-8"),
      );
      const parsed = JSON.parse(raw) as { daemon?: Partial<DaemonConfig> };
      // Start from DEFAULT, overlay config.json daemon key, then overlay
      // constructor overrides (already in this.config from constructor).
      if (parsed.daemon) {
        const constructorOverrides = this.config;
        this.config = {
          ...DEFAULT_DAEMON_CONFIG,
          ...parsed.daemon,
          // Constructor overrides win for top-level keys
          ...this.extractConstructorOverrides(constructorOverrides),
        };
        // Deep-merge memory sub-object
        this.config.memory = {
          ...DEFAULT_DAEMON_CONFIG.memory,
          ...(parsed.daemon.memory ?? {}),
          ...constructorOverrides.memory,
        };
      }
    } catch {
      // No daemon config in config.json — keep defaults
    }
  }

  /**
   * Extracts only the keys from `overrides` that differ from defaults.
   * Used to ensure constructor overrides take precedence over config.json.
   */
  private extractConstructorOverrides(overrides: DaemonConfig): Partial<DaemonConfig> {
    const result: Partial<DaemonConfig> = {};
    const defaults = DEFAULT_DAEMON_CONFIG;
    for (const key of Object.keys(overrides) as (keyof DaemonConfig)[]) {
      if (overrides[key] !== defaults[key]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result as any)[key] = overrides[key];
      }
    }
    return result;
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

    // Load skills
    const builtinSkillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
    const skillResult = await loadSkills({
      skillsDir: this.paths.skills,
      builtinDir: builtinSkillsDir,
    });
    this.skillRecords = skillResult.skills;

    for (const err of skillResult.errors) {
      log.warn("skill load error", { skill: err.skillName, message: err.message });
    }
    for (const w of skillResult.warnings) {
      log.warn("skill warning", { message: w });
    }

    const requireErrors = validateRequires(skillResult.skills);
    for (const err of requireErrors) {
      log.warn("skill requires error", { message: err });
    }

    // Build hot-set (Tier-0)
    const telemetryPath = telemetryPathFor(this.paths.skills);
    const telemetry = await readTelemetry(telemetryPath);
    const hotSet = buildHotSet(skillResult.skills, telemetry);
    const hotSetBlock = renderHotSet(hotSet);

    log.info("skills loaded", {
      total: skillResult.skills.length,
      errors: skillResult.errors.length,
      hotSet: hotSet.length,
    });

    // Load tools (with skills)
    const tools = loadTools({
      memoryBackend: this.memoryService?.getBackend(),
      skills: this.skillRecords,
      skillsDir: this.paths.skills,
    });

    // Create agent — compaction options are now passed per run() call,
    // not on the shared agent config, to avoid sessionId race conditions.
    this.agent = createAgent({
      tools,
      model: this.model,
      inlineThinking: (this.model as ResolvedModel).inlineThinking ?? false,
    });

    // Load system prompt
    const coreMemory = await loadCoreMemoryRaw(this.paths.core);
    const basePrompt = prompt("system-prompt", { inboxPath: this.paths.inbox });
    const composed = composeSystemPrompt(basePrompt, coreMemory);
    const fullPrompt = hotSetBlock
      ? `${composed}\n\n${hotSetBlock}`
      : composed;
    this.agent.setSystemPrompt(fullPrompt);

    log.info("agent initialized", { model: this.model.name });
  }

  /**
   * Detects 401/403 auth errors and appends a hint about the specific
   * API key variable that is likely missing, including whether it is
   * currently set in the environment.
   */
  private enhanceAuthError(msg: string): string {
    const isAuthError =
      /\b401\b/.test(msg) ||
      /\b403\b/.test(msg) ||
      /unauthorized/i.test(msg) ||
      /forbidden/i.test(msg) ||
      /invalid.*api.*key/i.test(msg);

    if (!isAuthError) return msg;

    // Determine the likely env var from the configured model/provider.
    const provider = this.model?.provider ?? "unknown";
    const providerEnvMap: Record<string, string> = {
      minimax: "MINIMAX_API_KEY",
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      azure: "AZURE_OPENAI_API_KEY",
      google: "GEMINI_API_KEY",
      gemini: "GEMINI_API_KEY",
      groq: "GROQ_API_KEY",
      mistral: "MISTRAL_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      perplexity: "PERPLEXITY_API_KEY",
    };
    const envVar = providerEnvMap[provider] ?? `${provider.toUpperCase()}_API_KEY`;
    const isSet = !!process.env[envVar];

    // Also check for custom env: references in config
    const configApiKey = this.configDefaultModel
      ? (this.configDefaultModel as unknown as { apiKey?: string }).apiKey
      : undefined;
    let customEnvHint = "";
    if (configApiKey?.startsWith("env:")) {
      const customVar = configApiKey.slice(4);
      const customSet = !!process.env[customVar];
      customEnvHint = `\nConfig references env var: ${customVar} (currently ${customSet ? "set ✓" : "NOT SET ✗"})`;
    }

    return (
      `${msg}\n\n` +
      `Authentication failed for provider '${provider}'.\n` +
      `Expected API key env var: ${envVar} (currently ${isSet ? "set ✓" : "NOT SET ✗"})` +
      customEnvHint +
      `\n.env location: ${this.paths.home}/.env\n` +
      `Add your provider key there, then restart: harness daemon restart`
    );
  }

  private createSessionEntry(
    session: Session,
    origin: SessionOrigin,
    title: string,
  ): SessionEntry {
    const now = new Date().toISOString();
    return {
      session,
      messages: [],
      turnsCompleted: 0,
      metricsRecorder: createMetricsRecorder({ sessionId: session.id }),
      origin,
      title,
      createdAt: session.createdAt ?? now,
      lastActiveAt: session.lastActivityAt ?? now,
      mailbox: createMailbox(),
      turnQueue: Promise.resolve(),
    };
  }

  /**
   * Daemon-side slash command handling for submit-turn.
   *
   * These commands are interpreted in the daemon (not the client) so they
   * work identically across all gateways (TUI, WhatsApp, etc.).
   *
   * Supported commands:
   *   /new      — End current session, create a new one.
   *   /sessions — List all sessions.
   *   /resume <id> — Resume a specific session.
   *   /end      — End the current session explicitly.
   *
   * Returns an IpcResponse if the command was handled, or null if the
   * text is not a recognized slash command (caller continues with normal
   * turn processing).
   */
  private async tryHandleSlashCommand(
    text: string,
    sessionId: string,
    send?: (resp: IpcResponse) => void,
  ): Promise<IpcResponse | null> {
    const trimmed = text.trim();

    // /new — end current session, start a new one
    if (trimmed === "/new") {
      // Read origin before deleting the session entry
      const entry = this.sessions.get(sessionId);
      const oldOrigin = entry?.origin ?? "api";
      if (entry) {
        entry.session = await endSession(entry.session, this.paths);
        this.sessions.delete(sessionId);
      } else {
        const loaded = await loadSession(sessionId, this.paths);
        if (loaded) await endSession(loaded.session, this.paths);
      }
      // Create new session
      const session = await createSession(this.paths, {
        model: this.model?.name ?? "unknown",
        title: "IPC Session",
      });
      const newEntry = this.createSessionEntry(session, oldOrigin, "IPC Session");
      this.sessions.set(session.id, newEntry);
      const log = this.logger.child("session");
      log.info("session created via /new", { oldId: sessionId, newId: session.id });
      return {
        type: "turn-complete",
        sessionId: session.id,
        finalResponse: `Started new session: ${session.id}`,
        info: "/new",
        turnsCompleted: 0,
      };
    }

    // /end — end the current session explicitly
    if (trimmed === "/end") {
      const entry = this.sessions.get(sessionId);
      if (entry) {
        entry.session = await endSession(entry.session, this.paths);
        this.sessions.delete(sessionId);
      } else {
        const loaded = await loadSession(sessionId, this.paths);
        if (loaded) await endSession(loaded.session, this.paths);
      }
      const log = this.logger.child("session");
      log.info("session ended via /end", { id: sessionId });
      return {
        type: "turn-complete",
        sessionId,
        finalResponse: "Session ended. Type a message to start a new session.",
        info: "/end",
        turnsCompleted: 0,
      };
    }

    // /sessions — list all sessions
    if (trimmed === "/sessions") {
      const persisted = await listSessions(this.paths);
      const summaries: SessionSummary[] = [];

      const inMemoryIds = new Set(this.sessions.keys());
      for (const [id, e] of this.sessions) {
        summaries.push({
          sessionId: id,
          title: e.title,
          origin: e.origin,
          status: "active",
          createdAt: e.createdAt,
          lastActiveAt: e.lastActiveAt,
          model: e.session.model,
          turnsCompleted: e.turnsCompleted,
          inMemory: true,
        });
      }
      for (const idx of persisted) {
        if (inMemoryIds.has(idx.sessionId)) continue;
        const turnCount = await countTurnsInTranscript(idx.sessionId, this.paths);
        summaries.push({
          sessionId: idx.sessionId,
          title: idx.title,
          origin: "api",
          status: idx.status,
          createdAt: idx.created,
          lastActiveAt: idx.lastActivity,
          model: idx.model,
          turnsCompleted: turnCount,
          inMemory: false,
        });
      }
      summaries.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

      const lines = summaries.map((s) => {
        const date = s.createdAt.slice(0, 10);
        const mem = s.inMemory ? " ●" : "  ";
        return `${mem} ${s.sessionId} · ${date} · ${s.origin} · ${s.status} · ${s.turnsCompleted} turns`;
      });
      const text = lines.length > 0
        ? `Sessions:\n${lines.map((l) => `  ${l}`).join("\n")}`
        : "No sessions found.";

      return {
        type: "turn-complete",
        sessionId,
        finalResponse: text,
        info: "/sessions",
        turnsCompleted: this.sessions.get(sessionId)?.turnsCompleted ?? 0,
      };
    }

    // /resume <id> — resume a specific session
    const resumeMatch = trimmed.match(/^\/resume\s+(\S+)/);
    if (resumeMatch) {
      const targetId = resumeMatch[1]!;

      // End the current session
      const currentEntry = this.sessions.get(sessionId);
      if (currentEntry) {
        currentEntry.session = await endSession(currentEntry.session, this.paths);
        this.sessions.delete(sessionId);
      }

      // Resume the target session
      if (this.sessions.has(targetId)) {
        const entry = this.sessions.get(targetId)!;
        return {
          type: "turn-complete",
          sessionId: targetId,
          finalResponse: `Resumed session: ${targetId} (${entry.messages.length} messages)`,
          info: "/resume",
          turnsCompleted: entry.turnsCompleted,
        };
      }

      const loaded = await loadSession(targetId, this.paths);
      if (!loaded) {
        return {
          type: "error",
          message: `Session not found: ${targetId}`,
          sessionId,
        };
      }
      if (loaded.session.status === "ended") {
        return {
          type: "error",
          message: `Session ${targetId} is ended and cannot be resumed.`,
          sessionId,
        };
      }
      const entry = this.createSessionEntry(loaded.session, "api", loaded.session.title);
      entry.session = { ...entry.session, status: "active" };
      entry.messages = loaded.turns.length > 0 ? turnsToMessages(loaded.turns) : [];
      this.sessions.set(targetId, entry);
      const log = this.logger.child("session");
      log.info("session resumed via /resume", { id: targetId });

      return {
        type: "turn-complete",
        sessionId: targetId,
        finalResponse: `Resumed session: ${targetId} (${entry.messages.length} messages)`,
        info: "/resume",
        turnsCompleted: entry.turnsCompleted,
      };
    }

    // /compact — manually trigger context compaction
    if (trimmed === "/compact") {
      const entry = this.sessions.get(sessionId);
      if (!entry) {
        return {
          type: "error",
          message: "No active session to compact.",
          sessionId,
        };
      }
      if (!this.model) {
        return {
          type: "error",
          message: "Model not initialized.",
          sessionId,
        };
      }

      send?.({ type: "turn-event", sessionId, event: { type: "status", status: "compacting" } });
      const tokensBefore = estimateTokens(entry.messages);
      const compactResult = await compactSession(entry.messages, {
        model: this.model,
        paths: this.paths,
        sessionId,
      });

      if (compactResult.performed) {
        entry.messages = compactResult.messages;
        const tokensAfter = estimateTokens(entry.messages);
        return {
          type: "turn-complete",
          sessionId,
          finalResponse: `Compacted ${compactResult.compactedTurnCount} messages.\nTokens: ${tokensBefore} → ${tokensAfter}\nAlt-context: ${compactResult.altContextPath}`,
          info: "/compact",
          turnsCompleted: entry.turnsCompleted,
        };
      } else {
        return {
          type: "turn-complete",
          sessionId,
          finalResponse: `No compaction needed (not enough messages or compaction would not reduce size).\nTokens: ${tokensBefore}\nAlt-context: ${compactResult.altContextPath || "(none)"}`,
          info: "/compact",
          turnsCompleted: entry.turnsCompleted,
        };
      }
    }

    void send; // send is used for streaming, not needed for slash commands
    return null;
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
