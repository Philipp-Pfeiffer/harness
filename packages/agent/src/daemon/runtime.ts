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
  estimateContextOverhead,
  loadSkills,
  validateRequires,
  readTelemetry,
  telemetryPathFor,
  buildHotSet,
  renderHotSet,
  loadAgentProfiles,
  ALL_MEMORY_ZONES,
  type HarnessPaths,
  type ConfigModel,
  type BrowserConfig,
  type ImageConfig,
  type WebConfig,
  type Agent,
  type MetricsRecorder,
  type DaemonEventType,
  type Mailbox,
  type ResolvedModel,
  type SkillRecord,
  type Tool,
  type AgentProfile,
  type MemoryZone,
  type MemoryBackend,
  type Logger,
} from "@harness/core";
import { processSupervisor } from "@harness/core";
import { buildStatusSummary, formatStatusSummary } from "../core/statusSummary.js";
import { loadCoreMemoryRaw } from "../core/coreMemory.js";
import { composeProfilePrompt } from "../core/profilePrompt.js";
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
  setSessionModelRef,
  extractToolData,
  extractAssistantTextFromMessages,
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

import { createWhatsAppPlugin } from "../whatsapp/plugin.js";
import { SESSION_INACTIVITY_THRESHOLD_MS } from "../whatsapp/limits.js";
import { shouldNotifyWhatsAppSessionReset } from "../whatsapp/sessionPolicy.js";
import { extractPhoneNumber, formatJid } from "../whatsapp/whitelist.js";
import { channelAddendum } from "./channelAddendum.js";
import { PerKeyLock } from "../util/perKeyLock.js";
import type { ChannelPlugin } from "./types.js";
import {
  HARNESS_REPO_DIR,
  currentGitHead,
  readPendingRestart,
  scheduleRestart,
  sendRestartPing,
  RESTART_FOLLOWUP_PROMPT,
} from "./selfModify.js";
import { runDeploy, DEPLOY_TIMEOUT_MS } from "./deploy.js";
import { waitForChannelReady } from "./restartPing.js";

/** Formats a context window size for user feedback, e.g. 131072 → "128k". */
function formatContextWindow(contextWindow: number | undefined): string {
  if (contextWindow === undefined || contextWindow <= 0) return "?";
  return `${Math.round(contextWindow / 1024)}k`;
}

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
  /** Agent profile this session runs under ("default" when unspecified). */
  profile: string;
  /** Selected model ref (config id, alias, or provider/model) for default-profile sessions. */
  modelRef?: string;
  /** Mailbox for steering messages that arrive while a turn is running. */
  mailbox: Mailbox;
  /** Turn queue: serializes turns per session. A second submit-turn on the
   *  same session waits for the first to complete instead of racing on
   *  entry.messages in-place. Messages arriving mid-turn go to the mailbox. */
  turnQueue: Promise<unknown>;
}

/**
 * Runtime context derived from an agent profile: the agent instance with
 * its system prompt, model and tool set, plus the granted memory zones
 * (used to gate ambient hints per turn).
 */
interface ProfileAgentContext {
  agent: Agent;
  model: Model<Api> | null;
  tools: Tool[];
  prompt: string;
  memoryZones: MemoryZone[];
  /** Working directory for the profile's tool calls. Null = daemon process cwd. */
  cwd: string | null;
}

export class DaemonRuntime {
  private readonly paths: HarnessPaths;
  private readonly logger: DaemonLogger;
  private config: DaemonConfig;
  private agent: Agent | null = null;
  private model: Model<Api> | null = null;
  private configDefaultModel: ConfigModel | undefined;
  private configModels: ConfigModel[] = [];
  private browserConfig: BrowserConfig | undefined;
  private imageConfig: ImageConfig | undefined;
  private webConfig: WebConfig | undefined;
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
  /** Loaded agent profiles by name (built-in + user overrides). */
  private profiles = new Map<string, AgentProfile>();
  /** Agent contexts per profile name, created lazily. */
  private readonly profileAgents = new Map<string, ProfileAgentContext>();
  /** Full tool set before profile allowlists/zone gating are applied. */
  private allTools: Tool[] = [];
  /** Tool set of the default profile (== this.agent's tools). */
  private defaultTools: Tool[] = [];
  /** Bare base prompt (runtime conventions), prefix of every profile prompt. */
  private basePrompt = "";
  /** Rendered skill hot-set block, shared by profiles with skills enabled. */
  private hotSetBlock = "";
  private coreMemoryRaw: string | undefined;
  /** Composed system prompt of the default profile (== this.agent's prompt). */
  private defaultPrompt = "";

  /**
   * Deferred restart requested by /deploy or /restart. Set while a turn
   * is running so the exit happens only after the turn + response are
   * fully sent. Guarded by selfModifyInFlight to serialize self-modification.
   */
  private pendingRestartReason: string | null = null;
  /** Whether a self-modification (deploy) is currently in flight. */
  private selfModifyInFlight = false;
  /** Whether any turn is currently running (used to defer restarts). */
  private turnActive = false;
  /** True while a post-restart follow-up turn is running (restart loop breaker). */
  private postRestartFollowUpActive = false;

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

  /** Build a Logger for tools, bridging to DaemonLogger's structured output. */
  private makeToolLogger(): Logger {
    const log = this.logger.child("tool");
    return (msg: string, level?: "warn" | "debug") => {
      if (level === "warn") log.warn(msg);
      else log.debug(msg);
    };
  }

  async start(): Promise<void> {
    await this.logger.init();
    const log = this.logger.child("runtime");
    log.info("daemon starting", { pid: process.pid, state: this.paths.state });

    // Inject structured logger into processSupervisor (replaces console.warn fallback)
    processSupervisor.setLogger(this.makeToolLogger());

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

    // Start gateways (WhatsApp plugin if configured)
    await this.initGateways();

    // Sessions are created on-demand — no initSession() here.

    // Start IPC server
    this.ipcServer = await startIpcServer(this.paths.socketFile, (req, send, ctx) =>
      this.handleIpcRequest(req, send, ctx),
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

    // Post-restart ping: if a previous run left a restart marker, report
    // back to the requesting channel, then consume the marker. Failures
    // are warn-logged — the marker is still removed (no retry storm).
    const marker = await readPendingRestart();
    if (marker) {
      log.info("found pending restart marker", {
        reason: marker.reason,
        target: marker.replyTarget,
        gitHead: marker.gitHead,
      });
      const plugin = this.channelPlugins.get("whatsapp");
      if (plugin) {
        try {
          await sendRestartPing(
            marker,
            (target, payload) => plugin.sendMessage(target, payload),
            (msg, level, data) => {
              if (level === "warn") log.warn(msg, data);
              else log.info(msg, data);
            },
            marker.followUp === true && marker.replyTarget
              ? () => this.runRestartFollowUp(marker.replyTarget, marker.reason)
              : undefined,
            () => waitForChannelReady(plugin, (msg, level, data) => {
              if (level === "warn") log.warn(msg, data);
              else log.info(msg, data);
            }),
          );
        } catch (err) {
          log.warn("restart ping send failed — marker already consumed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        log.warn("pending restart marker but no whatsapp plugin — marker consumed", {
          reason: marker.reason,
        });
      }
    }

    // Signal handlers
    process.on("SIGTERM", () => void this.shutdown("SIGTERM"));
    process.on("SIGINT", () => void this.shutdown("SIGINT"));
  }

  async shutdown(signal?: string): Promise<void> {
    await this.shutdownWithExit(signal, 0);
  }

  /**
   * Shutdown with an explicit exit code. Exit 0 = clean stop (systemd
   * does not restart), exit 1 = deferred self-restart (systemd restarts
   * with Restart=on-failure).
   */
  private async shutdownWithExit(
    signal: string | undefined,
    exitCode: number,
  ): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const log = this.logger.child("runtime");
    log.info("daemon shutting down", { signal, exitCode });

    const forceExit = setTimeout(() => {
      log.error("shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000);

    try {
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

      // Report offline presence after the gateways stopped — the WhatsApp
      // socket is still usable for a short window before the process exits.
      await this.setWhatsAppPresence("unavailable");

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
    } finally {
      clearTimeout(forceExit);
    }

    process.exit(exitCode);
  }

  /**
   * Deferred restart: requests a self-restart that takes effect after the
   * current turn finishes and its final response has been sent. The marker
   * is written so the intent survives even a mid-shutdown crash. systemd
   * sees exit code 1 and restarts the daemon (Restart=on-failure).
   * An optional announcement is flushed to the channel BEFORE the marker
   * so the user gets immediate feedback.
   *
   * @param gitHeadOverride New HEAD to record in the marker (e.g. after a
   *   deploy merged a branch). Defaults to the current repo HEAD.
   * @param followUp Whether the boot handler should run a follow-up turn
   *   instead of the static ping after the restart.
   * @param announceBeforeRestart Called BEFORE the marker is written so the
   *   user gets immediate feedback ("Restart eingeleitet …") even while a
   *   turn is still running. Awaited; failures are warn-logged and never
   *   block the restart.
   * @param awaitBeforeRestart Called right before an immediate restart when
   *   no turn is running. Lets the caller flush the confirmation message
   *   ("Deploy prepared, restarting…") through the channel BEFORE the
   *   shutdown begins — a send queued in the same tick as the shutdown can
   *   be cut off before it flushes.
   */
  async requestRestartAfterTurn(
    grund: string,
    benachrichtigeSession?: string,
    gitHeadOverride?: string,
    followUp?: boolean,
    announceBeforeRestart?: () => Promise<void>,
    awaitBeforeRestart?: () => Promise<void>,
  ): Promise<void> {
    const log = this.logger.child("self");
    log.info("requestRestartAfterTurn", {
      grund,
      replyTarget: benachrichtigeSession ?? "(none)",
      followUp: followUp === true ? true : undefined,
    });

    // Announce the restart BEFORE the marker is written — the user gets
    // feedback immediately instead of only after the "Back online" ping.
    if (announceBeforeRestart) {
      try {
        await announceBeforeRestart();
      } catch (err) {
        log.warn("pre-restart announcement failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Write the restart marker immediately — the shutdown path must not
    // lose this intent if it fails partway.
    let gitHead = gitHeadOverride ?? "";
    if (!gitHead) {
      try {
        gitHead = await currentGitHead(HARNESS_REPO_DIR);
      } catch (err) {
        log.warn("could not read git HEAD for restart marker", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await scheduleRestart(grund, benachrichtigeSession ?? "", gitHead, followUp);

    this.pendingRestartReason = grund;

    if (this.turnActive) {
      log.info("restart deferred — turn still running", {
        grund,
        replyTarget: benachrichtigeSession ?? "(none)",
      });
      return;
    }

    // No turn running — restart now via the clean shutdown path (exit 1).
    // If the caller needs to flush a confirmation message first (e.g. the
    // "Deploy prepared, restarting…" response), await it BEFORE the shutdown
    // is scheduled — otherwise the send may be cut off mid-flush.
    if (awaitBeforeRestart) {
      await awaitBeforeRestart();
    }
    // Deferred to the next macrotask so the caller's response (socket
    // write / WhatsApp outbound) can flush before the gateways stop.
    setImmediate(() => {
      void this.shutdownWithExit("self-restart", 1);
    });
  }

  /**
   * Builds the deferred-restart capability for the `request_restart` tool.
   * The tool calls it with a reason; the restart is scheduled for after
   * the current turn, targeted at the session that invoked the tool.
   *
   * Guards: while a restart/deploy is already pending or in flight, the
   * capability refuses (no double scheduling); while a post-restart
   * follow-up turn is running, it refuses too (loop breaker).
   */
  private makeRequestRestartCapability(sessionId: string) {
    return async (reason: string): Promise<{ ok: boolean; error?: string }> => {
      if (this.postRestartFollowUpActive) {
        return { ok: false, error: "restart not allowed during post-restart follow-up" };
      }
      if (this.selfModifyInFlight || this.pendingRestartReason) {
        return {
          ok: false,
          error: "restart already scheduled — a restart or deploy is already pending",
        };
      }
      try {
        const replyTarget = this.whatsappSessionToSource.get(sessionId) ?? "";
        await this.requestRestartAfterTurn(reason, replyTarget, undefined, true, () =>
          this.sendChannelResponse(
            sessionId,
            "Restart eingeleitet — bin in ~20 Sekunden zurück.",
          ),
        );
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.child("self").error("request_restart failed", { error: msg });
        return { ok: false, error: msg };
      }
    };
  }

  /**
   * Runs the post-restart follow-up: a short agent turn on the reply-target
   * session (same path as an incoming WhatsApp turn, including provenance
   * context). Throws on failure so sendRestartPing falls back to the
   * static ping.
   */
  private async runRestartFollowUp(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    const log = this.logger.child("self");
    log.info("running post-restart follow-up turn", { sessionId, reason });

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`follow-up session not found: ${sessionId}`);
    }

    let turnCtx: ProfileAgentContext;
    try {
      const turnProfile = this.resolveProfile(entry.profile);
      if (!turnProfile) throw new Error(`unknown agent profile "${entry.profile}"`);
      turnCtx = this.agentContextFor(turnProfile);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    turnCtx = this.applyTurnModel(turnCtx, entry.modelRef);

    const userMessage = {
      role: "user" as const,
      content: RESTART_FOLLOWUP_PROMPT(reason),
      timestamp: Date.now(),
    };
    entry.messages.push(userMessage as Message);

    let finalMessage = "";
    this.postRestartFollowUpActive = true;
    try {
      const result = await turnCtx.agent.run(entry.messages, {
        metricsRecorder: entry.metricsRecorder,
        memoryBackend: this.ambientMemoryBackend(turnCtx.memoryZones),
        cwd: turnCtx.cwd ?? undefined,
        compaction: {
          paths: this.paths,
          sessionId,
          threshold: DEFAULT_COMPACTION_THRESHOLD,
        },
        mailbox: entry.mailbox,
        channelFileSender: this.channelFileSender,
        requestRestart: this.makeRequestRestartCapability(sessionId),
        postRestartFollowUp: true,
        systemPromptAddendum: channelAddendum(entry.origin),
      });

      entry.turnsCompleted++;
      entry.lastActiveAt = new Date().toISOString();

      finalMessage = result.aborted ? `[Turn aborted: ${result.reason}]` : result.finalMessage;
      const turnStartIndex = Math.max(0, entry.messages.indexOf(userMessage as Message));
      const turnSlice = entry.messages.slice(turnStartIndex);
      const { tool_calls, tool_results } = extractToolData(turnSlice);
      const turn = {
        id: crypto.randomUUID(),
        role: "assistant" as const,
        content: finalMessage,
        userContent: userMessage.content,
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
          startedAt: new Date().toISOString(),
          latencyMs: 0,
        },
        model: turnCtx.model?.name ?? "unknown",
        timestamp: new Date().toISOString(),
        messages: turnSlice,
      };
      entry.session = await recordTurn(entry.session, turn, this.paths);
    } finally {
      this.postRestartFollowUpActive = false;
    }

    // Outbound: route the follow-up answer to the session's channel.
    const source = this.whatsappSessionToSource.get(sessionId);
    if (source) {
      const plugin = this.channelPlugins.get("whatsapp");
      if (plugin) {
        const target = formatJid(source);
        await plugin.sendMessage(target, { text: finalMessage });
        log.info("post-restart follow-up sent", { sessionId, target });
      }
    }
  }

  /**
   * Called after a turn completes and its final response has been sent.
   * If a deferred restart was requested, runs the same clean shutdown
   * path as SIGTERM (suspend sessions, stop gateways) with exit code 1
   * so systemd restarts the daemon.
   */
  private async performPendingRestartIfNeeded(): Promise<void> {
    if (!this.pendingRestartReason) return;
    const reason = this.pendingRestartReason;
    this.pendingRestartReason = null;
    const log = this.logger.child("self");
    log.info("performing deferred restart after turn", { reason });
    // Deferred to the next macrotask: the IPC response write and the
    // WhatsApp outbound must flush before the gateways are stopped.
    setImmediate(() => {
      void this.shutdownWithExit("self-restart", 1);
    });
  }

  /**
   * Whether a self-modification (deploy) is currently in flight.
   * Guards against parallel /deploy calls.
   */

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

      // Re-apply hot-reloadable settings (ambientHints checked per turn via ambientMemoryBackend)

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
   * turn. The job's optional `agent` field selects the agent profile for
   * the session (default: "default"). Returns the new session id.
   * Throws on failure — the scheduler catches and logs it.
   *
   * When the job has no body (bodyless agent job), a default trigger
   * prompt is sent as the first turn — the profile describes the task.
   */
  async runCronAgentJob(job: CronJob): Promise<string>;
  /**
   * Ad-hoc agent run: like runCronAgentJob(CronJob), but the agent
   * profile is given directly and the first turn is built from `input`.
   * Used by internal hooks (e.g. session-end after a session closes).
   */
  async runCronAgentJob(
    agent: string,
    input: { transcript: string },
  ): Promise<string>;
  async runCronAgentJob(
    jobOrAgent: CronJob | string,
    input?: { transcript: string },
  ): Promise<string> {
    const job: CronJob =
      typeof jobOrAgent === "string"
        ? {
            name: jobOrAgent,
            schedule: "* * * * * *",
            enabled: true,
            type: "agent",
            jitterMs: 0,
            agent: jobOrAgent,
            body: this.buildAdHocJobBody(jobOrAgent, input),
            filePath: "(hook)",
          }
        : jobOrAgent;

    const created = await this.handleIpcRequest({
      type: "create-session",
      origin: "cron",
      title: `cron: ${job.name}`,
      profile: job.agent,
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
      text: job.body || `Starte den Auftrag "${job.name}" gemäß deinem Agent-Profil.`,
      sessionId: created.sessionId,
    });
    if (resp.type === "error") {
      throw new Error(resp.message);
    }
    return created.sessionId;
  }

  /**
   * Builds the first-turn prompt for an ad-hoc agent run from its input.
   * The session-end agent reads the transcript and writes the protocol
   * next to it (`<transcript>.protocol.md`).
   */
  private buildAdHocJobBody(
    agent: string,
    input?: { transcript: string },
  ): string {
    if (!input) {
      throw new Error(
        `runCronAgentJob("${agent}") requires an input object`,
      );
    }
    if (agent === "session-end") {
      return [
        `Lies das Session-Transkript unter ${input.transcript} vollständig.`,
        `Schreibe daraus das Session-Protokoll gemäß deinem Agent-Profil (Session-End — Protokollant) nach ${input.transcript}.protocol.md.`,
      ].join("\n");
    }
    return [
      `Starte den Auftrag "${agent}" gemäß deinem Agent-Profil.`,
      ...Object.entries(input).map(
        ([key, value]) => `- ${key}: ${value}`,
      ),
    ].join("\n");
  }

  /**
   * Fire-and-forget session-end hook: after a session ends, start the
   * session-end agent with the transcript path as input. Errors are
   * logged, never propagated — a protocol failure must not block the
   * session close.
   */
  private triggerSessionEndJob(transcriptPath: string): void {
    void this.runCronAgentJob("session-end", { transcript: transcriptPath }).catch(
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.child("session-end").warn("session-end job failed", {
          transcript: transcriptPath,
          error: msg,
        });
      },
    );
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
    ctx?: { signal?: AbortSignal },
  ): Promise<IpcResponse> {
    switch (req.type) {
      case "ping":
        return { type: "pong", uptime: this.getUptimeSeconds(), pid: process.pid };

      case "status":
        return { type: "status", daemon: this.getStatus() };

      case "create-session": {
        const origin: SessionOrigin = req.origin ?? "api";
        const title = req.title ?? `${origin} session`;
        const profileName = req.profile ?? "default";
        const profile = this.resolveProfile(profileName);
        if (!profile) {
          const available = [...this.profiles.keys()].join(", ") || "(none loaded)";
          return {
            type: "error",
            message: `Unknown agent profile "${profileName}". Available profiles: ${available}`,
          };
        }
        // Eagerly resolve the profile's agent context so configuration
        // errors (e.g. an unresolvable model) surface as a clean error here.
        try {
          this.agentContextFor(profile);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.errorBuffer.push(msg);
          return { type: "error", message: msg };
        }
        const profileCtx = this.agentContextFor(profile);
        const modelRef = req.model ?? profileCtx.model?.id ?? this.model?.id;
        let sessionModelLabel: string;
        let storedModelRef: string | undefined = modelRef;
        if (modelRef || profileCtx.model || this.model) {
          const resolvedModel = this.resolveModelRef(modelRef, profileCtx.model ?? this.model);
          const configMatch = this.configModels.find((m) => m.model === resolvedModel.id);
          sessionModelLabel = configMatch?.alias ?? resolvedModel.name;
          storedModelRef = modelRef ?? resolvedModel.id;
        } else {
          sessionModelLabel = "unknown";
        }
        try {
          const session = await createSession(this.paths, {
            model: sessionModelLabel,
            title,
            profile: profile.name,
            origin,
            modelRef: storedModelRef,
          });
          const entry = this.createSessionEntry(session, origin, title, profile.name, storedModelRef);
          this.sessions.set(session.id, entry);
          const log = this.logger.child("session");
          log.info("session created", { id: session.id, origin, profile: profile.name });
          return {
            type: "session-created",
            sessionId: session.id,
            origin,
            createdAt: entry.createdAt,
            profile: profile.name,
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
              origin: idx.origin ?? "api", // Old sessions have no persisted origin — default
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
            loaded.session.origin ?? "api",
            loaded.session.title,
            loaded.session.profile ?? "default",
            loaded.session.modelRef ?? this.inferModelRefFromSessionLabel(loaded.session.model),
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
                loaded.session.origin ?? "api",
                loaded.session.title,
                loaded.session.profile ?? "default",
                loaded.session.modelRef ?? this.inferModelRefFromSessionLabel(loaded.session.model),
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
          //
          // The session's profile determines which agent (system prompt,
          // model, tool set) runs the turn. A profile that vanished since
          // the session was created surfaces as a clean error here.
          let turnCtx: ProfileAgentContext;
          try {
            const turnProfile = this.resolveProfile(entry.profile);
            if (!turnProfile) {
              const available = [...this.profiles.keys()].join(", ") || "(none loaded)";
              return {
                type: "error",
                message: `Unknown agent profile "${entry.profile}". Available profiles: ${available}`,
                sessionId,
              };
            }
            turnCtx = this.agentContextFor(turnProfile);
          } catch (err) {
            return {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
              sessionId,
            };
          }

          if (req.model) {
            entry.modelRef = req.model;
          }
          turnCtx = this.applyTurnModel(turnCtx, req.model ?? entry.modelRef);

          const agent = turnCtx.agent;
          const runQueuedTurn = async (): Promise<IpcResponse> => {
            const turnStartedAt = new Date().toISOString();
            const turnStartedMs = Date.now();

            // Build message array — inside the queued body, while holding
            // the queue. A queued turn never sees a later turn's user
            // message: no interleaves on entry.messages.
            let messages: Message[];
            // Track the user message by reference instead of a numeric index.
            // Mid-turn compaction replaces the messages array in-place
            // (agent.ts: messages.length = 0; messages.push(...compacted)),
            // which invalidates any numeric "before turn" index.
            let userMessage: Message | undefined;
            if (req.text) {
              // New-style: daemon manages context
              messages = entry.messages;
              userMessage = {
                role: "user",
                content: req.text,
                timestamp: Date.now(),
              } as Message;
              messages.push(userMessage);
            } else {
              // Old-style: caller provides full message array
              messages = req.messages as Message[];
            }

            this.turnActive = true;
            const result = await agent.run(messages, {
              signal: ctx?.signal,
              metricsRecorder: entry.metricsRecorder,
              memoryBackend: this.ambientMemoryBackend(turnCtx.memoryZones),
              cwd: turnCtx.cwd ?? undefined,
              compaction: {
                paths: this.paths,
                sessionId,
                threshold: DEFAULT_COMPACTION_THRESHOLD,
              },
              mailbox: entry.mailbox,
              systemPromptAddendum: channelAddendum(entry.origin),
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
                  case "status":
                    streamEvent = { type: "status", status: event.status };
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
            const turnStartIndex = userMessage
              ? Math.max(0, messages.indexOf(userMessage))
              : 0;
            const turnSlice = messages.slice(turnStartIndex);
            const partialContent = extractAssistantTextFromMessages(turnSlice);
            const finalMessage = result.aborted
              ? partialContent
              : result.finalMessage;
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
              model: turnCtx.model?.name ?? "unknown",
              timestamp: new Date().toISOString(),
              messages: turnSlice,
              aborted: result.aborted ? true : undefined,
              truncated: result.aborted && partialContent.length > 0 ? true : undefined,
            };
            entry.session = await recordTurn(entry.session, turn, this.paths);
            this.turnActive = false;
            // A deferred restart (requested mid-turn via /deploy or
            // /restart) fires after the turn body settles and the final
            // response has been written to the socket below.
            void this.performPendingRestartIfNeeded();

            return {
              type: "turn-complete" as const,
              sessionId,
              finalResponse: finalMessage,
              info: `Turn completed: ${result.aborted ? "aborted" : "ok"}, ${result.aborted ? result.completedTurns : result.turns} turns, ${result.usage.totalTokens} tokens`,
              turnsCompleted: entry.turnsCompleted,
              aborted: result.aborted,
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
          this.turnActive = false;
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
            const transcriptPath = entry.session.transcriptPath;
            entry.session = await endSession(entry.session, this.paths);
            this.sessions.delete(sessionId);
            const log = this.logger.child("session");
            log.info("session ended via IPC", { id: sessionId });
            this.triggerSessionEndJob(transcriptPath);
          } else {
            // Session not in memory — end it on disk directly
            const loaded = await loadSession(sessionId, this.paths);
            if (loaded) {
              await endSession(loaded.session, this.paths);
              const log = this.logger.child("session");
              log.info("session ended via IPC (disk-only)", { id: sessionId });
              this.triggerSessionEndJob(loaded.session.transcriptPath);
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
    this.configModels = result.models;
    this.browserConfig = result.browserConfig;
    this.imageConfig = result.imageConfig;
    this.webConfig = result.webConfig;

    if (result.warning) {
      this.logger.child("config").warn(result.warning);
    }

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

    // Load agent profiles (built-in + user overrides from $HARNESS_HOME/agents/)
    const builtinProfilesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
    const profileResult = await loadAgentProfiles({
      profilesDir: this.paths.agentProfiles,
      builtinDir: builtinProfilesDir,
      vars: { inboxPath: this.paths.inbox },
    });
    this.profiles = new Map(profileResult.profiles.map((p) => [p.name, p]));
    for (const err of profileResult.errors) {
      log.warn("agent profile load error", { profile: err.profileName, message: err.message });
    }

    const defaultProfile = this.profiles.get("default");
    if (!defaultProfile) {
      log.warn("default agent profile not found — falling back to prompts/system-prompt.md persona");
    }

    // A default profile may override the daemon's model.
    const defaultModelRef = defaultProfile?.frontmatter.model;
    if (defaultModelRef) {
      try {
        this.model = resolveModel(defaultModelRef.provider, defaultModelRef.model);
      } catch (err) {
        log.warn("default profile model could not be resolved, keeping daemon model", {
          model: `${defaultModelRef.provider}/${defaultModelRef.model}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
    this.allTools = loadTools({
      memoryBackend: this.memoryService?.getBackend(),
      webConfig: this.webConfig,
      skills: this.skillRecords,
      skillsDir: this.paths.skills,
      browser: {
        config: this.browserConfig,
        defaultModel: this.configDefaultModel,
        models: this.configModels,
        downloadsBaseDir: join(this.paths.state, "downloads"),
        browserRunsDir: this.paths.browserRuns,
      },
      image: {
        config: this.imageConfig,
        defaultModel: this.configDefaultModel,
        models: this.configModels,
      },
    });
    const defaultZones = defaultProfile?.frontmatter.memory ?? ALL_MEMORY_ZONES;
    this.defaultTools = this.applyProfileToolPolicy(
      this.allTools,
      defaultProfile?.frontmatter.tools,
      defaultZones,
    );

    // Create agent — compaction options are now passed per run() call,
    // not on the shared agent config, to avoid sessionId race conditions.
    this.agent = createAgent({
      tools: this.defaultTools,
      model: this.model,
      logger: this.makeToolLogger(),
      inlineThinking:
        defaultProfile?.frontmatter.thinking ??
        (this.model as ResolvedModel).inlineThinking ??
        false,
      temperature: defaultProfile?.frontmatter.temperature,
      maxTokens: defaultProfile?.frontmatter.maxTokens,
    });

    // Compose the default profile's system prompt:
    // bare base prompt + persona (profile body) + core memory + skill hot-set.
    this.coreMemoryRaw = await loadCoreMemoryRaw(this.paths.core);
    this.basePrompt = prompt("base-prompt");
    this.hotSetBlock = hotSetBlock;
    const defaultPersona =
      defaultProfile?.body ?? prompt("system-prompt", { inboxPath: this.paths.inbox });
    this.defaultPrompt = composeProfilePrompt({
      basePrompt: this.basePrompt,
      persona: defaultPersona,
      coreMemoryRaw: this.coreMemoryRaw,
      hotSetBlock,
      memoryZones: defaultZones,
      skillsHotSet: defaultProfile?.frontmatter.skills ?? true,
    });
    this.agent.setSystemPrompt(this.defaultPrompt);

    log.info("agent initialized", {
      model: this.model.name,
      profiles: this.profiles.size,
    });
  }

  // ─── Gateway Initialization ───

  /**
   * Initializes and registers gateway plugins based on daemon config.
   * WhatsApp is the first implementation.
   */
  private async initGateways(): Promise<void> {
    const log = this.logger.child("gateway");

    for (const gatewayName of this.config.gateways) {
      if (gatewayName === "whatsapp") {
        await this.initWhatsAppGateway();
      } else {
        log.warn("unknown gateway in config — skipping", { name: gatewayName });
      }
    }
  }

  /**
   * Creates and registers the WhatsApp ChannelPlugin.
   * Reads phone number + test mode from daemon config or env vars.
   */
  private async initWhatsAppGateway(): Promise<void> {
    const log = this.logger.child("whatsapp");
    const waConfig = this.config.whatsapp;

    const phoneNumber = waConfig?.phoneNumber ?? process.env.WHATSAPP_PHONE_NUMBER ?? "";
    const testMode = waConfig?.testMode ?? false;

    if (!phoneNumber) {
      log.warn("WhatsApp gateway enabled but no phone number configured — skipping");
      return;
    }

    log.info("starting WhatsApp gateway", { phoneNumber, testMode });

    const plugin = createWhatsAppPlugin({
      paths: this.paths,
      phoneNumber,
      testMode,
      log: (msg, level) => {
        if (level === "error") log.error(msg);
        else if (level === "warn") log.warn(msg);
        else log.info(msg);
      },
      model: this.model,
      modelSupportsVision: this.configDefaultModel?.supportsVision,
      callbacks: {
        submitTurn: async (sessionId, text, imageBlocks) => {
          return this.submitWhatsAppTurn(sessionId, text, imageBlocks);
        },
        compactSession: async (sessionId) => {
          await this.compactWhatsAppSession(sessionId);
        },
        rotateSessionForInactivity: async (source, sessionId) => {
          return this.rotateWhatsAppSession(source, sessionId);
        },
        resolveSession: async (source) => {
          return this.resolveWhatsAppSession(source);
        },
        steer: (sessionId, text) => {
          this.steerWhatsAppSession(sessionId, text);
        },
        checkToolExecuted: (sessionId) => {
          return this.checkWhatsAppToolExecuted(sessionId);
        },
        executeCommand: async (sessionId, text) => {
          const result = await this.handleChannelSlashCommand(sessionId, text);
          if (result === null) {
            return { response: "Unknown command. Type /help to see available commands." };
          }
          return result;
        },
        setPresence: (type, jid) => {
          void this.setWhatsAppPresence(type, jid);
        },
      },
    });

    await this.registerGateway(plugin);
    this.channelPlugins.set("whatsapp", plugin as ChannelPlugin);
  }

  /**
   * Forwards a WhatsApp presence update to the plugin: "available"/"unavailable"
   * for the account-wide online status, "composing"/"paused" for a chat.
   * Non-critical — failures are logged by the plugin, never fatal.
   */
  private async setWhatsAppPresence(
    type: "available" | "unavailable" | "composing" | "paused",
    jid?: string,
  ): Promise<void> {
    const plugin = this.channelPlugins.get("whatsapp");
    if (!plugin || typeof plugin.setPresence !== "function") return;
    try {
      // Account-wide status ("available"/"unavailable") and chat-level
      // indicators ("composing"/"paused") both route through the plugin.
      await plugin.setPresence(type, jid);
    } catch (err) {
      this.logger.child("whatsapp").warn("presence update failed", {
        type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Channel plugin registry for outbound routing. */
  private readonly channelPlugins = new Map<string, ChannelPlugin>();

  /** WhatsApp session map: phone number → session ID. */
  private readonly whatsappSessions = new Map<string, string>();

  /** Prevents duplicate session creation when many messages arrive at once. */
  private readonly whatsappSessionLock = new PerKeyLock();

  /**
   * Submits a turn from the WhatsApp plugin, image blocks included.
   * Returns the agent's final response for routing back to the channel.
   */
  private async submitWhatsAppTurn(
    sessionId: string,
    text: string,
    imageBlocks?: import("./types.js").InboundImageBlock[],
  ): Promise<{ finalResponse: string }> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    let turnCtx = this.agentContextFor(this.resolveProfile(entry.profile) ?? this.resolveProfile("default")!);
    turnCtx = this.applyTurnModel(turnCtx, entry.modelRef);

    // Build the user message with optional image content blocks
    let userContent: string | Array<{ type: string; text?: string; source?: { type: "base64"; mediaType: string; data: string } }> = text;
    if (imageBlocks && imageBlocks.length > 0) {
      const parts: Array<{ type: string; text?: string; source?: { type: "base64"; mediaType: string; data: string } }> = [];
      parts.push({ type: "text", text });
      for (const block of imageBlocks) {
        parts.push({
          type: "image",
          source: {
            type: "base64",
            mediaType: block.mimeType,
            data: block.data.toString("base64"),
          },
        });
      }
      userContent = parts;
    }

    const userMessage = {
      role: "user" as const,
      content: userContent,
      timestamp: Date.now(),
    };
    entry.messages.push(userMessage as Message);

    this.turnActive = true;
    // Progressive outbound: agent text chunks produced BEFORE a tool call
    // are delivered to the channel immediately, then tool execution runs.
    // Text of the final response is deliberately NOT sent here — the inbound
    // processor sends it once after the turn completes (prevents duplicates).
    let progressiveText = "";
    let sendChain: Promise<void> = Promise.resolve();
    const queueProgressiveSend = (text: string): void => {
      const source = this.whatsappSessionToSource.get(sessionId);
      if (!source) return;
      const plugin = this.channelPlugins.get("whatsapp");
      if (!plugin) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      // Serialize sends so multiple progressive segments keep their order.
      sendChain = sendChain.then(async () => {
        try {
          await plugin.sendMessage(formatJid(source), { text: trimmed });
          this.logger.child("whatsapp").info("progressive outbound sent", { sessionId, target: source });
          // A sent message can reset WhatsApp's composing state. Re-arm the
          // indicator immediately so the "tippt…" stays visible while the
          // turn continues (the inbound processor's 15s refresh may be too
          // slow to counteract it). Fire-and-forget, never fatal.
          if (this.turnActive) {
            this.setWhatsAppPresence("composing", formatJid(source)).catch(() => {});
          }
        } catch (err) {
          this.logger.child("whatsapp").warn("progressive outbound failed", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    };
    try {
      const result = await turnCtx.agent.run(entry.messages, {
        metricsRecorder: entry.metricsRecorder,
        memoryBackend: this.ambientMemoryBackend(turnCtx.memoryZones),
        cwd: turnCtx.cwd ?? undefined,
        compaction: {
          paths: this.paths,
          sessionId,
          threshold: DEFAULT_COMPACTION_THRESHOLD,
        },
        mailbox: entry.mailbox,
        channelFileSender: this.channelFileSender,
        requestRestart: this.makeRequestRestartCapability(sessionId),
        systemPromptAddendum: channelAddendum(entry.origin),
        onEvent: (event) => {
          if (event.type === "token") {
            progressiveText += event.text;
          } else if (event.type === "tool_call_start") {
            // Text before a tool call ships immediately; the buffer is
            // cleared. Any text after the last tool call is the final
            // response and is sent once by the inbound processor.
            queueProgressiveSend(progressiveText);
            progressiveText = "";
          }
        },
      });

      // Wait for all progressive sends so the inbound processor's final
      // response (sendOutbound) arrives after them — stable order.
      await sendChain;

      entry.turnsCompleted++;
      entry.lastActiveAt = new Date().toISOString();

      const finalMessage = result.aborted ?
        `[Turn aborted: ${result.reason}]` : result.finalMessage;
      const turnStartIndex = Math.max(0, entry.messages.indexOf(userMessage as Message));
      const turnSlice = entry.messages.slice(turnStartIndex);
      const { tool_calls, tool_results } = extractToolData(turnSlice);
      const turn = {
        id: crypto.randomUUID(),
        role: "assistant" as const,
        content: finalMessage,
        userContent: text,
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
          startedAt: new Date().toISOString(),
          latencyMs: 0,
        },
        model: turnCtx.model?.name ?? "unknown",
        timestamp: new Date().toISOString(),
        messages: turnSlice,
      };
      entry.session = await recordTurn(entry.session, turn, this.paths);

      return { finalResponse: finalMessage };
    } finally {
      this.turnActive = false;
      // If a restart was requested during this turn, trigger it now that
      // the turn is done. The outbound response is sent by the caller.
      void this.performPendingRestartIfNeeded();
    }
  }

  /**
   * Triggers compaction for a WhatsApp session (8h inactivity boundary).
   */
  private async compactWhatsAppSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || !this.model) return;

    const log = this.logger.child("whatsapp");
    log.info("triggering session compaction (8h inactivity)", { sessionId });

    try {
      const result = await compactSession(entry.messages, {
        model: this.model,
        paths: this.paths,
        sessionId,
      });
      if (result.performed) {
        entry.messages = result.messages;
        log.info("compaction completed", { sessionId, compacted: result.compactedTurnCount });
      }
    } catch (err) {
      log.error("compaction failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async resolveWhatsAppSession(source: string): Promise<{ sessionId: string; rotated: boolean }> {
    const phone = extractPhoneNumber(source);
    return this.whatsappSessionLock.run(phone, () => this.resolveWhatsAppSessionInner(phone));
  }

  /**
   * Resolves or creates a persistent WhatsApp session for a phone number.
   * On daemon restart: searches the session index for an existing WhatsApp
   * session matching this source. Resumes if found and <8h inactive,
   * otherwise creates a new session (notify only after >8h inactivity).
   *
   * Returns `{ sessionId, rotated }` where `rotated` is true when a stale
   * (>8h inactive) session was replaced by a fresh one. The caller submits
   * the current message immediately as the first turn instead of debouncing.
   */
  private async resolveWhatsAppSessionInner(phone: string): Promise<{ sessionId: string; rotated: boolean }> {
    // 1. Check in-memory map first
    const existing = this.whatsappSessions.get(phone);
    if (existing) {
      // Resume from disk if not in memory
      if (!this.sessions.has(existing)) {
        const loaded = await loadSession(existing, this.paths);
        if (loaded && loaded.session.status !== "ended") {
          const entry = this.createSessionEntry(
            loaded.session,
            loaded.session.origin ?? ("whatsapp" as SessionOrigin),
            `WhatsApp: ${phone}`,
            loaded.session.profile ?? "default",
            loaded.session.modelRef,
          );
          entry.session = { ...entry.session, status: "active" };
          entry.messages = loaded.turns.length > 0 ? turnsToMessages(loaded.turns) : [];
          this.sessions.set(existing, entry);
        } else {
          // Session was ended or not found — create a new one (no reset notice)
          return { sessionId: await this.createWhatsAppSession(phone, false), rotated: false };
        }
      }
      return { sessionId: existing, rotated: false };
    }

    // 2. Map is empty → search session index for existing WhatsApp session
    const expectedTitle = `WhatsApp: ${phone}`;
    let notifySessionReset = false;
    try {
      const index = await listSessions(this.paths);
      // Find most recent WhatsApp session for this source that's not ended
      const matches = index
        .filter((e) => e.title === expectedTitle && e.status !== "ended")
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

      if (matches.length > 0) {
        const match = matches[0]!;
        const lastActivityMs = new Date(match.lastActivity).getTime();
        const inactiveMs = Date.now() - lastActivityMs;

        if (inactiveMs < SESSION_INACTIVITY_THRESHOLD_MS) {
          // Resume existing session
          const loaded = await loadSession(match.sessionId, this.paths);
          if (loaded) {
            const entry = this.createSessionEntry(
              loaded.session,
              loaded.session.origin ?? ("whatsapp" as SessionOrigin),
              expectedTitle,
              loaded.session.profile ?? "default",
              loaded.session.modelRef,
            );
            entry.session = { ...entry.session, status: "active" };
            entry.messages = loaded.turns.length > 0 ? turnsToMessages(loaded.turns) : [];
            this.sessions.set(match.sessionId, entry);
            this.whatsappSessions.set(phone, match.sessionId);
            this.whatsappSessionToSource.set(match.sessionId, phone);
            return { sessionId: match.sessionId, rotated: false };
          }
        } else {
          // Session is too old (>8h) — create new one, notify in chat
          notifySessionReset = true;
        }
      }
    } catch {
      // Index read failed — fall through to new session creation
    }

    // 3. Create new session
    const sessionId = await this.createWhatsAppSession(phone, notifySessionReset);
    return { sessionId, rotated: notifySessionReset };
  }

  /**
   * Rotates a WhatsApp session after 8h inactivity while the daemon is running.
   * Compacts and ends the old session, creates a fresh one, and notifies the user.
   */
  private async rotateWhatsAppSession(source: string, oldSessionId: string): Promise<string> {
    const phone = extractPhoneNumber(source);
    await this.compactWhatsAppSession(oldSessionId);

    const oldEntry = this.sessions.get(oldSessionId);
    if (oldEntry) {
      const transcriptPath = oldEntry.session.transcriptPath;
      await endSession(oldEntry.session, this.paths);
      this.sessions.delete(oldSessionId);
      this.triggerSessionEndJob(transcriptPath);
    }
    this.whatsappSessionToSource.delete(oldSessionId);
    this.whatsappSessions.delete(phone);

    return this.whatsappSessionLock.run(phone, () => this.createWhatsAppSession(phone, true));
  }

  private async createWhatsAppSession(phone: string, notifySessionReset: boolean): Promise<string> {
    const expectedTitle = `WhatsApp: ${phone}`;
    const session = await createSession(this.paths, {
      model: this.model?.name ?? "unknown",
      title: expectedTitle,
      origin: "whatsapp",
    });
    const entry = this.createSessionEntry(session, "whatsapp" as SessionOrigin, expectedTitle);
    this.sessions.set(session.id, entry);
    this.whatsappSessions.set(phone, session.id);
    this.whatsappSessionToSource.set(session.id, phone);

    if (shouldNotifyWhatsAppSessionReset(notifySessionReset)) {
      await this.sendWhatsAppSessionResetNotice(phone);
    }

    return session.id;
  }

  private async sendWhatsAppSessionResetNotice(phone: string): Promise<void> {
    const plugin = this.channelPlugins.get("whatsapp");
    if (!plugin) return;

    try {
      await plugin.sendMessage(formatJid(phone), {
        text: "[Neue Session gestartet — vorheriger Kontext wurde zurückgesetzt.]",
      });
    } catch {
      // Non-critical
    }
  }

  /**
   * Steers a running WhatsApp turn by pushing to the session's mailbox.
   */
  private steerWhatsAppSession(sessionId: string, text: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.mailbox.push(text);
    }
  }

  /**
   * Checks whether a tool has executed in the current WhatsApp turn.
   * Delegates to the session's metrics recorder's last turn data.
   */
  private checkWhatsAppToolExecuted(sessionId: string): boolean {
    // The agent loop tracks tool calls internally. Since we can't directly
    // inspect the agent's internal state from here, we use a pragmatic
    // heuristic: once agent.run() is awaiting, we assume tools may have
    // started. The actual check is whether we're past the first LLM call.
    // For v1, we track this via a per-session flag.
    const flag = this.whatsappToolExecuted.get(sessionId);
    return flag ?? false;
  }

  /** Per-session tool-executed flag for WhatsApp turns. */
  private readonly whatsappToolExecuted = new Map<string, boolean>();

  /**
   * Channel file sender callback for the `send_file` tool.
   * Looks up the channel plugin and source JID for the session,
   * then sends the file via the plugin's sendMessage method.
   */
  private readonly channelFileSender = async (
    sessionId: string,
    file: { path: string; mimeType: string; caption?: string },
  ): Promise<{ ok: boolean; error?: string }> => {
    // Find the source (phone number) for this session
    const source = this.whatsappSessionToSource.get(sessionId);
    if (!source) {
      return { ok: false, error: "Kein Channel-Kontext für diese Session (kein WhatsApp-Chat aktiv)." };
    }

    const plugin = this.channelPlugins.get("whatsapp");
    if (!plugin) {
      return { ok: false, error: "Kein WhatsApp-Plugin aktiv." };
    }

    try {
      const { formatJid } = await import("../whatsapp/whitelist.js");
      const target = formatJid(source);
      await plugin.sendMessage(target, {
        files: [{ path: file.path, mimeType: file.mimeType, caption: file.caption }],
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  };

  /** Reverse map: session ID → source phone number. */
  private readonly whatsappSessionToSource = new Map<string, string>();

  /**
   * Applies a profile's tool policy to the full tool set: an explicit
   * `tools` allowlist filters by name (unknown names are logged and
   * ignored); `search_memory` additionally requires the "notes" memory
   * zone. Never throws.
   */
  private applyProfileToolPolicy(
    allTools: Tool[],
    allowlist: string[] | undefined,
    zones: MemoryZone[],
  ): Tool[] {
    let tools = allTools;
    if (allowlist) {
      const known = new Set(allTools.map((t) => t.name));
      const unknown = allowlist.filter((name) => !known.has(name));
      if (unknown.length > 0) {
        this.logger.child("agent").warn("profile lists unknown tools — ignored", {
          tools: unknown.join(", "),
        });
      }
      const allow = new Set(allowlist);
      tools = tools.filter((t) => allow.has(t.name));
    }
    if (!zones.includes("notes")) {
      tools = tools.filter((t) => t.name !== "search_memory");
    }
    return tools;
  }

  /**
   * Resolves a profile by name. "default" always resolves — when no
   * default profile was loaded (e.g. init not run), a synthesized
   * fallback keeps the daemon usable.
   */
  private resolveProfile(name: string): AgentProfile | undefined {
    const profile = this.profiles.get(name);
    if (profile) return profile;
    if (name === "default") {
      return {
        name: "default",
        frontmatter: { name: "default", skills: true, cwd: null },
        body: "",
        filePath: "",
        dir: "",
        builtin: true,
      };
    }
    return undefined;
  }

  /**
   * Returns the agent context for a profile, creating and caching it on
   * first use. The default profile's context wraps the shared daemon
   * agent. Throws when the profile's model cannot be resolved or the
   * daemon is not fully initialized.
   */
  private agentContextFor(profile: AgentProfile): ProfileAgentContext {
    const cached = this.profileAgents.get(profile.name);
    if (cached) return cached;

    if (profile.name === "default") {
      if (!this.agent) {
        throw new Error("Daemon not fully initialized (agent missing)");
      }
      const ctx: ProfileAgentContext = {
        agent: this.agent,
        model: this.model,
        tools: this.defaultTools,
        prompt: this.defaultPrompt,
        memoryZones: profile.frontmatter.memory ?? ALL_MEMORY_ZONES,
        cwd: profile.frontmatter.cwd ?? null,
      };
      this.profileAgents.set("default", ctx);
      return ctx;
    }

    if (!this.model) {
      throw new Error("Daemon not fully initialized (model missing)");
    }
    const fm = profile.frontmatter;
    // Profile model refs may be OpenRouter presets (`@preset/deepseek-flash`
    // configured in `config.json`). `resolveModel` cannot resolve those —
    // the preset is resolved via the config model list instead. Any other
    // provider/model goes through plain `resolveModel`, which throws for
    // unknown providers.
    let model = this.model;
    if (fm.model) {
      if (fm.model.provider === "@preset") {
        const preset = `${fm.model.provider}/${fm.model.model}`;
        const fromConfig = this.configModels.find(
          (m) => m.model === preset || `${m.provider}/${m.model}` === preset,
        );
        if (!fromConfig) {
          throw new Error(
            `Unknown OpenRouter preset "${preset}" in profile "${profile.name}". Add it to config.models in $HARNESS_HOME/config.json.`,
          );
        }
        model = resolveModelFromConfig(fromConfig);
      } else {
        model = resolveModel(fm.model.provider, fm.model.model);
      }
    }
    const zones = fm.memory ?? ALL_MEMORY_ZONES;
    const tools = this.applyProfileToolPolicy(this.allTools, fm.tools, zones);
    const promptText = composeProfilePrompt({
      basePrompt: this.basePrompt,
      persona: profile.body,
      coreMemoryRaw: this.coreMemoryRaw,
      hotSetBlock: this.hotSetBlock,
      memoryZones: zones,
      skillsHotSet: fm.skills,
    });
    const agent = createAgent({
      tools,
      model,
      logger: this.makeToolLogger(),
      inlineThinking: fm.thinking ?? (model as ResolvedModel).inlineThinking ?? false,
      temperature: fm.temperature,
      maxTokens: fm.maxTokens,
    });
    agent.setSystemPrompt(promptText);

    const ctx: ProfileAgentContext = { agent, model, tools, prompt: promptText, memoryZones: zones, cwd: profile.frontmatter.cwd ?? null };
    this.profileAgents.set(profile.name, ctx);
    this.logger.child("agent").info("profile agent created", {
      profile: profile.name,
      model: model.name,
      tools: tools.length,
    });
    return ctx;
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
    profile: string = "default",
    modelRef?: string,
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
      profile,
      modelRef,
      mailbox: createMailbox(),
      turnQueue: Promise.resolve(),
    };
  }

  /**
   * Resolves a model reference against the configured models.
   *
   * Match priority (first hit wins, case-insensitive):
   *   1. exact `keyword` match (e.g. `/model flash`)
   *   2. exact `model` id match (e.g. `/model @preset/deepseek-flash`)
   *   3. exact `alias` match (e.g. `/model DeepSeek Flash`)
   *   4. exact `provider/model` match
   *   5. substring match against keyword, model, alias, or provider —
   *      "flash" matches "@preset/deepseek-flash" and "DeepSeek Flash".
   *      Empty or whitespace-only keywords never match.
   */
  private findConfigModel(ref: string): ConfigModel | undefined {
    const keyword = ref.trim().toLowerCase();
    if (!keyword) return undefined;

    const substring = (field: string | undefined): boolean =>
      field !== undefined && field.length > 0 && field.toLowerCase().includes(keyword);

    const exact = (field: string | undefined): boolean =>
      field !== undefined && field.toLowerCase() === keyword;

    return (
      this.configModels.find((m) => exact(m.keyword)) ??
      this.configModels.find((m) => exact(m.model)) ??
      this.configModels.find((m) => exact(m.alias)) ??
      this.configModels.find((m) => exact(`${m.provider}/${m.model}`)) ??
      this.configModels.find(
        (m) =>
          substring(m.keyword) ||
          substring(m.model) ||
          substring(m.alias) ||
          substring(m.provider),
      )
    );
  }

  private resolveModelRef(ref: string | undefined, fallback?: Model<Api> | null): Model<Api> {
    if (!ref) {
      if (fallback) return fallback;
      if (!this.model) throw new Error("Daemon not fully initialized (model missing)");
      return this.model;
    }

    const fromConfig = this.findConfigModel(ref);
    if (fromConfig) {
      return resolveModelFromConfig(fromConfig);
    }

    if (fallback && (ref === fallback.id || ref === fallback.name)) {
      return fallback;
    }

    const slash = ref.indexOf("/");
    if (slash > 0) {
      try {
        return resolveModel(ref.slice(0, slash), ref.slice(slash + 1));
      } catch {
        // fall through to default
      }
    }

    if (!this.model) throw new Error("Daemon not fully initialized (model missing)");
    return this.model;
  }

  /** Maps a persisted session.model label back to a config preset ref. */
  private inferModelRefFromSessionLabel(label: string | undefined): string | undefined {
    if (!label) return undefined;
    const match = this.configModels.find((m) => {
      return m.keyword === label || m.alias === label || m.model === label || `${m.provider}/${m.model}` === label;
    });
    return match?.model ?? label;
  }

  /**
   * Resolves the model currently active for a session (session-specific
   * modelRef, then the profile model, then the daemon default). Returns
   * null if the session's model ref is unresolvable.
   */
  private currentSessionModel(entry: SessionEntry | undefined): Model<Api> | null {
    if (!entry) return this.model ?? null;
    try {
      const profile = this.resolveProfile(entry.profile) ?? this.resolveProfile("default");
      const profileModel = profile ? this.agentContextFor(profile).model : null;
      return this.resolveModelRef(entry.modelRef, profileModel ?? this.model);
    } catch {
      return null;
    }
  }

  private applyTurnModel(
    turnCtx: ProfileAgentContext,
    modelRef: string | undefined,
  ): ProfileAgentContext {
    if (!modelRef && !turnCtx.model && !this.model) {
      return turnCtx;
    }
    const turnModel = this.resolveModelRef(modelRef, turnCtx.model ?? this.model);
    if (turnCtx.agent === this.agent && typeof turnCtx.agent.setModel === "function") {
      turnCtx.agent.setModel(turnModel);
      return { ...turnCtx, model: turnModel };
    }
    return turnCtx;
  }

  /** Ambient L2 hints — gated by config and profile memory zone. */
  private ambientMemoryBackend(memoryZones: MemoryZone[]): MemoryBackend | undefined {
    if (!this.config.memory.ambientHints) return undefined;
    if (!memoryZones.includes("notes")) return undefined;
    return this.memoryService?.getBackend() ?? undefined;
  }

  /**
   * Channel-agnostic slash command handler. Returns a response string
   * and optionally a new session ID (when /new or /resume changes the
   * session). Returns null if the text is not a recognized slash command.
   *
   * Supported commands:
   *   /help     — List all available commands.
   *   /status   — Show daemon + session status including active model.
   *   /model    — Show active model + list available models.
   *   /model <keyword|alias|model|provider/model> — Switch model for the
   *               current session (keyword match wins, substring fallback).
   *   /model default — Reset the session to the config default model.
   *   /new      — End current session, create a new one.
   *   /end      — End the current session explicitly.
   *   /sessions — List all sessions.
   *   /resume <id> — Resume a specific session.
   *   /compact  — Manually trigger context compaction.
   */
  async handleChannelSlashCommand(
    sessionId: string,
    text: string,
  ): Promise<{ response: string; newSessionId?: string } | null> {
    const trimmed = text.trim();

    // /help — list all available commands
    if (trimmed === "/help") {
      return {
        response: [
          "Commands:",
          "/help — Show this list",
          "/status — Daemon status + active model",
          "/model — Show active model + list",
          "/model <keyword|alias|model> — Switch model",
          "/model default — Reset to default model",
          "/new — Start a fresh session",
          "/end — End current session",
          "/sessions — List all sessions",
          "/resume <id> — Resume a session",
          "/compact — Compact context window",
          "/restart — Restart the daemon (after the current turn)",
          "/deploy <branch> — Merge branch into main, build, restart",
        ].join("\n"),
      };
    }

    // /status — daemon + session status
    if (trimmed === "/status" || trimmed.startsWith("/status ")) {
      const entry = this.sessions.get(sessionId);
      const activeModel = entry?.session.model ?? this.model?.name ?? "unknown";
      const modelRefLabel = entry?.modelRef ? ` (ref: ${entry.modelRef})` : "";

      // Resolve the model that owns this session's context window. Prefers
      // the model switched via /model, then the session's profile model.
      let turnModel: Model<Api> | null = null;
      if (entry) {
        const profile = this.resolveProfile(entry.profile) ?? this.resolveProfile("default");
        if (profile) {
          try {
            turnModel = this.resolveModelRef(entry.modelRef, this.agentContextFor(profile).model ?? this.model);
          } catch {
            turnModel = this.model;
          }
        }
      }
      const modelForContext = turnModel ?? this.model;

      // Live context estimate: message history + system prompt + tool defs.
      // Mirrors the compaction trigger (shouldCompact) so the fill % answers
      // "when will compaction happen?".
      let contextTokens: number | undefined;
      if (entry) {
        try {
          let promptText = this.defaultPrompt;
          let toolSet = this.defaultTools;
          const profile = this.resolveProfile(entry.profile) ?? this.resolveProfile("default");
          if (profile) {
            const ctx = this.agentContextFor(profile);
            promptText = ctx.prompt;
            toolSet = ctx.tools;
          }
          contextTokens =
            estimateTokens(entry.messages) +
            estimateContextOverhead(promptText, toolSet);
        } catch {
          // Profile model unresolvable — leave contextTokens undefined.
        }
      }

      const summary = await buildStatusSummary({
        sessionState: entry ? "active" : "ready",
        model: `${activeModel}${modelRefLabel}`,
        contextWindow: modelForContext?.contextWindow,
        workspace: process.cwd(),
        sessionId,
        sessionUsage: entry?.session.tokenTotals
          ? {
              inputTokens: entry.session.tokenTotals.inputTokens,
              outputTokens: entry.session.tokenTotals.outputTokens,
              totalTokens: entry.session.tokenTotals.totalTokens,
              cacheRead: entry.session.tokenTotals.cacheRead,
              cacheWrite: entry.session.tokenTotals.cacheWrite,
            }
          : undefined,
        contextTokens,
        memoryReady: this.memoryService ? !this.memoryService.degraded : false,
        toolCalls: entry?.turnsCompleted ?? 0,
        errors: this.errorBuffer.snapshot().length,
        daemon: {
          pid: process.pid,
          uptimeSeconds: Math.floor((Date.now() - this.startMs) / 1000),
          gateways: [...this.gateways.keys()].join(", ") || "none",
        },
      });
      return { response: formatStatusSummary(summary) };
    }

    // /model — show active model + list all configured models
    if (trimmed === "/model" || trimmed === "/model list") {
      const entry = this.sessions.get(sessionId);
      const activeModel = this.currentSessionModel(entry);
      const activeLabel = activeModel
        ? `Modell: ${activeModel.name} (${formatContextWindow(activeModel.contextWindow)})`
        : `Active model: ${entry?.modelRef ?? entry?.session.model ?? "unknown"}`;

      if (this.configModels.length === 0) {
        return { response: `${activeLabel}\nNo other models configured.` };
      }

      const activeRef = entry?.modelRef ?? "";
      const lines = this.configModels.map((m) => {
        const keyword = m.keyword ? `${m.keyword} — ` : "";
        const label = `${m.alias || `${m.provider}/${m.model}`} (${m.provider}/${m.model})`;
        const isActive =
          (activeModel !== null && m.model === activeModel.id) ||
          (activeRef.length > 0 &&
            (activeRef.toLowerCase() === m.keyword?.toLowerCase() ||
              activeRef.toLowerCase() === m.alias.toLowerCase() ||
              activeRef.toLowerCase() === m.model.toLowerCase()));
        return `${isActive ? "* " : "  "}${keyword}${label}`;
      });
      return {
        response:
          `${activeLabel}\n\nVerfügbare Modelle:\n${lines.join("\n")}\n\nWechseln mit /model <keyword|alias|model>.`,
      };
    }

    // /model <ref> — switch model
    const modelMatch = trimmed.match(/^\/model\s+(.+)/);
    if (modelMatch) {
      const ref = modelMatch[1]!.trim();
      const entry = this.sessions.get(sessionId);

      // /model default — reset to the config default model
      if (ref.toLowerCase() === "default") {
        if (entry) {
          entry.modelRef = undefined;
          entry.session = await setSessionModelRef(entry.session, "", this.paths);
          const log = this.logger.child("session");
          log.info("model reset to default via /model", { sessionId });
        }
        const target = this.resolveModelRef(undefined, this.model);
        return { response: `Modell: ${target.name} (${formatContextWindow(target.contextWindow)})` };
      }

      const match = this.findConfigModel(ref);
      if (!match) {
        const names = this.configModels.map((m) => m.keyword ?? m.alias ?? `${m.provider}/${m.model}`).join(", ");
        return { response: `Unbekanntes Modell: "${ref}".\nVerfügbar: ${names}` };
      }
      const resolved = resolveModelFromConfig(match);
      if (entry) {
        entry.modelRef = ref;
        entry.session = await setSessionModelRef(entry.session, ref, this.paths);
        const log = this.logger.child("session");
        log.info("model switched via /model", { sessionId, model: ref });
      }
      return { response: `Modell: ${resolved.name} (${formatContextWindow(resolved.contextWindow)})` };
    }

    // /restart — schedule a deferred self-restart (no build steps)
    if (trimmed === "/restart") {
      const replyTarget = this.whatsappSessionToSource.get(sessionId) ?? "";

      if (this.selfModifyInFlight) {
        return {
          response: "A self-modification is already in progress. Try again shortly.",
        };
      }

      const immediateResponse = "Restarting — back in a few seconds.";
      await this.requestRestartAfterTurn(
        "manual /restart",
        replyTarget,
        undefined,
        false,
        async () => {
          await this.sendChannelResponse(sessionId, immediateResponse);
        },
      );

      if (this.turnActive) {
        return {
          response: "Restart scheduled — will restart after the current turn finishes.",
        };
      }
      // No turn running: the confirmation was already flushed to the channel
      // by awaitBeforeRestart — don't send it twice.
      return { response: "" };
    }

    // /deploy <branch> — merge a branch into main, build/test, restart
    const deployMatch = trimmed.match(/^\/deploy\s+(\S+)/);
    if (deployMatch) {
      return this.handleDeployCommand(sessionId, deployMatch[1]!);
    }

    // Delegate to session commands
    return this.executeSessionSlashCommand(trimmed, sessionId);
  }

  /**
   * /deploy <branch> — merges the branch into main, runs build/typecheck/
   * tests, and on success schedules a deferred restart. On any failure:
   * main is restored to the previous HEAD, the error is answered, and NO
   * restart happens.
   */
  private async handleDeployCommand(
    sessionId: string,
    branch: string,
  ): Promise<{ response: string }> {
    const log = this.logger.child("self");

    // Branch-pflicht: /deploy on main itself is rejected.
    if (branch === "main" || branch === "origin/main" || branch === "HEAD") {
      return { response: "Deploy rejected: deploying main onto itself is not supported. Specify a feature branch." };
    }

    // Turn-Queue beachten: /deploy darf auch während eines laufenden Turns
    // ausgeführt werden, aber nicht parallel zu einem anderen /deploy.
    if (this.selfModifyInFlight) {
      return { response: "A deploy is already in progress. Wait for it to finish." };
    }
    this.selfModifyInFlight = true;
    try {
      // Sofortiges ACK — bevor das Deploy-Skript überhaupt startet, damit
      // der Nutzer weiß, dass der Auftrag angenommen wurde. Awaited, damit
      // die Nachricht geflusht ist, bevor die langlaufende Deploy-Phase beginnt.
      await this.sendChannelResponse(
        sessionId,
        `Deploy ${branch} angestoßen — bauen, testen, restarten...`,
      );

      const result = await runDeploy(
        HARNESS_REPO_DIR,
        branch,
        (msg, level, data) => {
          if (level === "warn") log.warn(msg, data);
          else log.info(msg, data);
        },
        { timeoutMs: DEPLOY_TIMEOUT_MS },
      );

      if (!result.ok) {
        // Fehler: main wurde zurückgesetzt, kein Restart.
        return { response: result.message };
      }

      // Erfolg: Marker schreiben + Deferred Restart über den gemeinsamen
      // requestRestartAfterTurn-Pfad. gitHead kommt aus dem Deploy-Ergebnis.
      const replyTarget = this.whatsappSessionToSource.get(sessionId) ?? "";
      const immediateResponse = "Deploy prepared, restarting…";
      await this.requestRestartAfterTurn(
        `deploy ${branch}`,
        replyTarget,
        result.gitHead,
        false,
        async () => {
          await this.sendChannelResponse(sessionId, immediateResponse);
        },
      );

      if (this.turnActive) {
        return {
          response:
            "Deploy prepared, restarting… (after the current turn finishes)",
        };
      }
      // No turn running: the confirmation was already flushed to the channel
      // by awaitBeforeRestart — don't send it twice.
      return { response: "" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("deploy command failed", { error: msg });
      return { response: `Deploy failed: ${msg}` };
    } finally {
      this.selfModifyInFlight = false;
    }
  }

  /**
   * Sends a command response to the session's WhatsApp channel, awaiting
   * the actual send. Used before an immediate (no-turn) restart so the
   * confirmation message is guaranteed to reach Baileys BEFORE the
   * shutdown begins. Falls back to a warn log if no channel/session is
   * available — the restart still proceeds.
   */
  private async sendChannelResponse(
    sessionId: string,
    text: string,
  ): Promise<void> {
    const source = this.whatsappSessionToSource.get(sessionId);
    if (!source) return;
    const plugin = this.channelPlugins.get("whatsapp");
    if (!plugin) return;
    const log = this.logger.child("self");
    try {
      await plugin.sendMessage(formatJid(source), { text });
      log.info("pre-restart confirmation sent", { sessionId, target: source });
    } catch (err) {
      log.warn("pre-restart confirmation send failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Session-scoped slash commands shared by IPC and channel paths.
   * Returns {response} for success, or null if not a recognized command.
   */
  private async executeSessionSlashCommand(
    trimmed: string,
    sessionId: string,
  ): Promise<{ response: string; newSessionId?: string } | null> {
    // /new — end current session, start a new one
    if (trimmed === "/new") {
      const entry = this.sessions.get(sessionId);
      const oldOrigin = entry?.origin ?? "api";
      const oldTitle = entry?.title ?? "Channel Session";
      if (entry) {
        const transcriptPath = entry.session.transcriptPath;
        entry.session = await endSession(entry.session, this.paths);
        this.sessions.delete(sessionId);
        this.triggerSessionEndJob(transcriptPath);
      } else {
        const loaded = await loadSession(sessionId, this.paths);
        if (loaded) {
          await endSession(loaded.session, this.paths);
          this.triggerSessionEndJob(loaded.session.transcriptPath);
        }
      }
      const session = await createSession(this.paths, {
        model: this.model?.name ?? "unknown",
        title: oldTitle,
        origin: oldOrigin,
      });
      const newEntry = this.createSessionEntry(session, oldOrigin, oldTitle);
      this.sessions.set(session.id, newEntry);
      const log = this.logger.child("session");
      log.info("session created via /new", { oldId: sessionId, newId: session.id });

      // Update WhatsApp session mapping if this is a WhatsApp session
      const phone = this.whatsappSessionToSource.get(sessionId);
      if (phone) {
        this.whatsappSessionToSource.delete(sessionId);
        this.whatsappSessionToSource.set(session.id, phone);
        this.whatsappSessions.set(phone, session.id);
      }

      return { response: `Started new session: ${session.id}`, newSessionId: session.id };
    }

    // /end — end the current session explicitly
    if (trimmed === "/end") {
      const entry = this.sessions.get(sessionId);
      if (entry) {
        const transcriptPath = entry.session.transcriptPath;
        entry.session = await endSession(entry.session, this.paths);
        this.sessions.delete(sessionId);
        this.triggerSessionEndJob(transcriptPath);
      } else {
        const loaded = await loadSession(sessionId, this.paths);
        if (loaded) {
          await endSession(loaded.session, this.paths);
          this.triggerSessionEndJob(loaded.session.transcriptPath);
        }
      }
      const log = this.logger.child("session");
      log.info("session ended via /end", { id: sessionId });

      // Cleanup WhatsApp mapping
      const phone = this.whatsappSessionToSource.get(sessionId);
      if (phone) {
        this.whatsappSessionToSource.delete(sessionId);
        this.whatsappSessions.delete(phone);
      }

      return { response: "Session ended. Send any message to start a new session." };
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
          origin: idx.origin ?? "api",
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

      return { response: text };
    }

    // /resume <id> — resume a specific session
    const resumeMatch = trimmed.match(/^\/resume\s+(\S+)/);
    if (resumeMatch) {
      const targetId = resumeMatch[1]!;

      const currentEntry = this.sessions.get(sessionId);
      const oldPhone = this.whatsappSessionToSource.get(sessionId);
      if (currentEntry) {
        const transcriptPath = currentEntry.session.transcriptPath;
        currentEntry.session = await endSession(currentEntry.session, this.paths);
        this.sessions.delete(sessionId);
        this.triggerSessionEndJob(transcriptPath);
      }
      if (oldPhone) {
        this.whatsappSessionToSource.delete(sessionId);
      }

      if (this.sessions.has(targetId)) {
        const entry = this.sessions.get(targetId)!;
        if (oldPhone) {
          this.whatsappSessionToSource.set(targetId, oldPhone);
          this.whatsappSessions.set(oldPhone, targetId);
        }
        return {
          response: `Resumed session: ${targetId} (${entry.messages.length} messages)`,
          newSessionId: targetId,
        };
      }

      const loaded = await loadSession(targetId, this.paths);
      if (!loaded) {
        return { response: `Session not found: ${targetId}` };
      }
      if (loaded.session.status === "ended") {
        return { response: `Session ${targetId} is ended and cannot be resumed.` };
      }
      const entry = this.createSessionEntry(
        loaded.session,
        loaded.session.origin ?? "api",
        loaded.session.title,
        loaded.session.profile ?? "default",
        loaded.session.modelRef ?? this.inferModelRefFromSessionLabel(loaded.session.model),
      );
      entry.session = { ...entry.session, status: "active" };
      entry.messages = loaded.turns.length > 0 ? turnsToMessages(loaded.turns) : [];
      this.sessions.set(targetId, entry);
      const log = this.logger.child("session");
      log.info("session resumed via /resume", { id: targetId });

      if (oldPhone) {
        this.whatsappSessionToSource.set(targetId, oldPhone);
        this.whatsappSessions.set(oldPhone, targetId);
      }

      return {
        response: `Resumed session: ${targetId} (${entry.messages.length} messages)`,
        newSessionId: targetId,
      };
    }

    // /compact — manually trigger context compaction
    if (trimmed === "/compact") {
      const entry = this.sessions.get(sessionId);
      if (!entry) {
        return { response: "No active session to compact." };
      }
      if (!this.model) {
        return { response: "Model not initialized." };
      }

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
          response: `Compacted ${compactResult.compactedTurnCount} messages.\nTokens: ${tokensBefore} → ${tokensAfter}\nAlt-context: ${compactResult.altContextPath}`,
        };
      } else {
        return {
          response: `No compaction needed.\nTokens: ${tokensBefore}\nAlt-context: ${compactResult.altContextPath || "(none)"}`,
        };
      }
    }

    return null;
  }

  /**
   * Daemon-side slash command handling for submit-turn (IPC path).
   *
   * Delegates to handleChannelSlashCommand and wraps the result in
   * IpcResponse. Returns null for unrecognized commands so the caller
   * continues with normal turn processing.
   */
  private async tryHandleSlashCommand(
    text: string,
    sessionId: string,
    send?: (resp: IpcResponse) => void,
  ): Promise<IpcResponse | null> {
    const trimmed = text.trim();

    // /compact via IPC sends streaming status events, so handle it specially
    if (trimmed === "/compact") {
      const entry = this.sessions.get(sessionId);
      if (!entry) {
        return { type: "error", message: "No active session to compact.", sessionId };
      }
      if (!this.model) {
        return { type: "error", message: "Model not initialized.", sessionId };
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

    // For all other commands, delegate to the shared handler
    const result = await this.handleChannelSlashCommand(sessionId, trimmed);
    if (result === null) {
      void send;
      return null;
    }

    return {
      type: "turn-complete",
      sessionId: result.newSessionId ?? sessionId,
      finalResponse: result.response,
      info: trimmed.split(/\s+/)[0]!.replace("/", ""),
      turnsCompleted: this.sessions.get(result.newSessionId ?? sessionId)?.turnsCompleted ?? 0,
    };
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
