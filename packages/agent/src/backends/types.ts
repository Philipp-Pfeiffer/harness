import type { SessionSummary } from "../daemon/types.js";
import type { SessionTurn } from "../core/session.js";

/**
 * Events streamed during a turn. Both InProcessBackend and DaemonClientBackend
 * emit the same event shape so the TUI renders identically regardless of
 * whether the agent loop runs locally or in the daemon.
 */
export type BackendEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call_start"; name: string; args: unknown }
  | { type: "tool_call_done"; name: string; result: string }
  | { type: "tool_call_error"; name: string; error: string }
  | { type: "turn_end" }
  | { type: "status"; status: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheRead: number;
      cacheWrite: number;
    };

export interface TurnResult {
  finalResponse: string;
  aborted: boolean;
  turnsCompleted: number;
  /** If the turn changed the session (e.g. /new creates a new one), this is the new session ID. */
  sessionId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface SessionData {
  sessionId: string;
  turns: SessionTurn[];
  tokenEstimate: number;
  model?: string;
}

export interface CreateSessionOpts {
  model?: string;
  title?: string;
}

/**
 * Abstracts the agent execution layer. The TUI renders against this
 * interface, not against the agent loop directly.
 *
 * - InProcessBackend: runs the agent loop in-process (Werkbank-Modus).
 * - DaemonClientBackend: delegates to the daemon via IPC.
 */
export interface AgentBackend {
  /** Backend name for display/logging. */
  readonly name: string;

  /** Whether this backend supports runtime model switching. */
  readonly supportsModelSwitching: boolean;

  /**
   * Create a new session.
   * Returns the new session ID.
   */
  createSession(opts?: CreateSessionOpts): Promise<{ sessionId: string }>;

  /**
   * Resume an existing session. Returns turn history for display.
   */
  resumeSession(sessionId: string): Promise<SessionData>;

  /**
   * List all sessions (in-memory + persisted).
   */
  listSessions(): Promise<SessionSummary[]>;

  /**
   * End a session explicitly (sets status to "ended").
   */
  endSession(sessionId: string): Promise<void>;

  /**
   * Run a turn, streaming events via onEvent.
   * Resolves when the turn completes.
   */
  runTurn(
    text: string,
    sessionId: string,
    onEvent: (event: BackendEvent) => void,
    signal?: AbortSignal,
  ): Promise<TurnResult>;
}
