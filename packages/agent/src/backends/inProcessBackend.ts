import { randomUUID } from "node:crypto";

import type { Message, Model, Api } from "@mariozechner/pi-ai";
import {
  resolveHarnessPaths,
  createMailbox,
  createMetricsRecorder,
  type Agent,
  type AgentEvent,
  type HarnessPaths,
  type MemoryBackend,
  type MetricsRecorder,
  type RunResult,
} from "@harness/core";
import type { SessionSummary } from "../daemon/types.js";
import {
  createSession,
  recordTurn,
  endSession,
  loadSession,
  listSessions,
  turnsToMessages,
  countTurnsInTranscript,
  calculateTurnCost,
  type Session,
  type SessionTurn,
} from "../core/session.js";
import type {
  AgentBackend,
  BackendEvent,
  CreateSessionOpts,
  SessionData,
  TurnResult,
} from "./types.js";

/**
 * AgentBackend that runs the agent loop in-process (Werkbank-Modus).
 * This is the traditional TUI mode where everything runs locally.
 *
 * Unlike the DaemonClientBackend, this backend manages sessions directly
 * on the filesystem and runs the agent loop via the in-process Agent.
 */
export class InProcessBackend implements AgentBackend {
  readonly name = "in-process";
  readonly supportsModelSwitching = true;

  private readonly paths: HarnessPaths;
  private readonly getMemoryBackend: () => MemoryBackend | undefined;
  private readonly agent: Agent;
  private readonly modelRef: { current: Model<Api> };
  private readonly sessions = new Map<string, { session: Session; messages: Message[]; metricsRecorder: MetricsRecorder }>();

  constructor(opts: {
    paths?: HarnessPaths;
    agent: Agent;
    model: Model<Api>;
    memoryBackend?: () => MemoryBackend | undefined;
  }) {
    this.paths = opts.paths ?? resolveHarnessPaths();
    this.agent = opts.agent;
    this.modelRef = { current: opts.model };
    this.getMemoryBackend = opts.memoryBackend ?? (() => undefined);
  }

  /** Exposed for App.tsx to access the agent for model switching. */
  getAgent(): Agent { return this.agent; }

  /** Exposed for App.tsx to set the current model. */
  setModel(model: Model<Api>): void {
    this.modelRef.current = model;
    this.agent.setModel(model);
  }

  /** Current model reference. */
  get model(): Model<Api> { return this.modelRef.current; }

  async createSession(opts?: CreateSessionOpts): Promise<{ sessionId: string }> {
    const session = await createSession(this.paths, {
      model: opts?.model ?? this.modelRef.current.name,
      title: opts?.title ?? "CLI Session",
    });
    this.sessions.set(session.id, {
      session,
      messages: [],
      metricsRecorder: createMetricsRecorder({ sessionId: session.id }),
    });
    return { sessionId: session.id };
  }

  async resumeSession(sessionId: string): Promise<SessionData> {
    const loaded = await loadSession(sessionId, this.paths);
    if (!loaded) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = turnsToMessages(loaded.turns);
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.session = loaded.session;
      entry.messages = messages;
    } else {
      this.sessions.set(sessionId, {
        session: loaded.session,
        messages,
        metricsRecorder: createMetricsRecorder({ sessionId }),
      });
    }

    return {
      sessionId,
      turns: loaded.turns,
      tokenEstimate: loaded.tokenEstimate,
      model: loaded.session.model,
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const index = await listSessions(this.paths);
    const summaries: SessionSummary[] = [];
    const inMemoryIds = new Set(this.sessions.keys());

    // In-memory sessions
    for (const [id, entry] of this.sessions) {
      summaries.push({
        sessionId: id,
        title: entry.session.title,
        origin: "tui",
        status: entry.session.status,
        createdAt: entry.session.createdAt,
        lastActiveAt: entry.session.lastActivityAt,
        model: entry.session.model,
        turnsCompleted: 0, // Not tracked per-session in InProcessBackend
        inMemory: true,
      });
    }

    // Persisted sessions not in memory
    for (const idx of index) {
      if (inMemoryIds.has(idx.sessionId)) continue;
      const turnCount = await countTurnsInTranscript(idx.sessionId, this.paths);
      summaries.push({
        sessionId: idx.sessionId,
        title: idx.title,
        origin: "api", // Origin not persisted in index
        status: idx.status,
        createdAt: idx.created,
        lastActiveAt: idx.lastActivity,
        model: idx.model,
        turnsCompleted: turnCount,
        inMemory: false,
      });
    }

    summaries.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    return summaries;
  }

  async endSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.session = await endSession(entry.session, this.paths);
      this.sessions.delete(sessionId);
    } else {
      // Session not in memory — end on disk
      const loaded = await loadSession(sessionId, this.paths);
      if (loaded) {
        await endSession(loaded.session, this.paths);
      }
    }
  }

  async runTurn(
    text: string,
    sessionId: string,
    onEvent: (event: BackendEvent) => void,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = entry.messages;
    const messagesBeforeTurn = messages.length;
    messages.push({ role: "user", content: text, timestamp: Date.now() } as Message);

    const mailbox = createMailbox();
    const abortCommandRef = { current: undefined as string | undefined };
    const runStartMs = Date.now();

    // Wire abort signal to abortCommandRef
    if (signal) {
      signal.addEventListener("abort", () => {
        abortCommandRef.current = signal.reason ?? "aborted";
      }, { once: true });
    }

    const result = await this.agent.run(messages, {
      signal,
      mailbox,
      abortCommand: abortCommandRef,
      memoryBackend: this.getMemoryBackend(),
      metricsRecorder: entry.metricsRecorder,
      onEvent: (event: AgentEvent) => {
        const backendEvent = translateAgentEvent(event);
        if (backendEvent) {
          onEvent(backendEvent);
        }
      },
    });

    entry.session = await this.persistTurn(
      entry, result, text, messagesBeforeTurn, messages, runStartMs,
    );

    return {
      finalResponse: result.aborted ? "Aborted" : result.finalMessage,
      aborted: result.aborted,
      turnsCompleted: result.aborted ? result.completedTurns : result.turns,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
      },
    };
  }

  private async persistTurn(
    entry: { session: Session; messages: Message[]; metricsRecorder: MetricsRecorder },
    result: RunResult,
    userText: string,
    messagesBeforeTurn: number,
    messages: Message[],
    runStartMs: number,
  ): Promise<Session> {
    const finalMessage = result.aborted ? "Aborted" : result.finalMessage;
    const sessionTurn: SessionTurn = {
      id: randomUUID(),
      role: "assistant",
      content: finalMessage,
      userContent: userText,
      tool_calls: [],
      tool_results: [],
      tokens: {
        input: result.usage.inputTokens,
        output: result.usage.outputTokens,
        total: result.usage.totalTokens,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
      },
      cost: calculateTurnCost(
        {
          input: result.usage.inputTokens,
          output: result.usage.outputTokens,
          total: result.usage.totalTokens,
          cacheRead: result.usage.cacheRead,
          cacheWrite: result.usage.cacheWrite,
        },
        this.modelRef.current.cost,
      ),
      timing: {
        startedAt: new Date(runStartMs).toISOString(),
        latencyMs: Date.now() - runStartMs,
      },
      model: this.modelRef.current.name,
      timestamp: new Date().toISOString(),
      messages: messages.slice(messagesBeforeTurn),
    };
    return recordTurn(entry.session, sessionTurn, this.paths);
  }
}

function translateAgentEvent(event: AgentEvent): BackendEvent | null {
  switch (event.type) {
    case "token":
      return { type: "token", text: event.text };
    case "tool_call_start":
      return { type: "tool_call_start", name: event.name, args: event.args };
    case "tool_call_done":
      return { type: "tool_call_done", name: event.name, result: event.result };
    case "tool_call_error":
      return { type: "tool_call_error", name: event.name, error: event.error };
    case "turn_end":
      return { type: "turn_end" };
    case "usage":
      return {
        type: "usage",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalTokens: event.totalTokens,
        cacheRead: event.cacheRead,
        cacheWrite: event.cacheWrite,
      };
    default:
      return null;
  }
}
