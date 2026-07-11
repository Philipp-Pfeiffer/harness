import type { Message } from "@mariozechner/pi-ai";

/* ─── Gateway Adapter Interface ─── */

/**
 * Contract for gateway adapters (WhatsApp, Telegram, etc.).
 * The daemon manages the lifecycle; the adapter bridges inbound/outbound
 * messages between an external transport and the agent loop.
 *
 * Implementation comes per-gateway (e.g. whatsapp.ts docking here in the
 * next goal). The daemon only calls these methods.
 */
export interface GatewayAdapter {
  /** Human-readable adapter name, e.g. "whatsapp". */
  readonly name: string;
  /** Start the gateway connection (connect, authenticate, begin listening). */
  start(): Promise<void>;
  /** Gracefully stop the gateway (disconnect, flush, release resources). */
  stop(): Promise<void>;
  /** Returns true if the gateway is healthy and connected. */
  healthCheck(): Promise<boolean>;
  /** Register a handler for inbound messages from the transport. */
  onInbound(handler: (message: InboundMessage) => void): void;
}

export interface InboundMessage {
  /** Gateway-specific source identifier (phone number, chat id, etc.). */
  source: string;
  /** Text content of the inbound message. */
  text: string;
  /** ISO timestamp of receipt. */
  timestamp: string;
}

/* ─── Session Origin ─── */

export type SessionOrigin = "tui" | "cron" | "whatsapp" | "api";

/* ─── IPC Protocol (Unix socket) ─── */

/**
 * New-style submit-turn: `text` is the new user message.
 * The daemon maintains the session's message context internally.
 *
 * Old-style submit-turn: `messages` carries the full conversation.
 * Used by the TUI which manages its own context.
 *
 * If `sessionId` is omitted, the daemon creates a new session.
 */
export type IpcRequest =
  | { type: "ping" }
  | { type: "status" }
  | { type: "create-session"; origin?: SessionOrigin; title?: string; model?: string }
  | { type: "list-sessions" }
  | { type: "submit-turn"; messages?: SerializedMessage[]; text?: string; model?: string; sessionId?: string }
  | { type: "resume-session"; sessionId: string }
  | { type: "end-session"; sessionId: string }
  | { type: "reload-config" }
  | { type: "shutdown" };

/**
 * Streaming protocol: intermediate `turn-event` frames are sent first,
 * followed by the terminal `turn-complete` (or `error`) frame.
 * Non-streaming request types produce a single terminal response.
 *
 * `sessionId` is present on session-scoped responses.
 */
export type IpcResponse =
  | { type: "pong"; uptime: number; pid: number }
  | { type: "status"; daemon: DaemonStatusInfo }
  | { type: "session-created"; sessionId: string; origin: SessionOrigin; createdAt: string }
  | { type: "sessions-listed"; sessions: SessionSummary[] }
  | { type: "session-resumed"; sessionId: string; messageCount: number }
  | { type: "session-ended"; sessionId: string }
  | { type: "turn-event"; sessionId: string; event: TurnStreamEvent }
  | { type: "turn-complete"; sessionId: string; finalResponse: string; info: string; turnsCompleted: number; usage?: TurnUsage }
  | { type: "config-reloaded"; ok: boolean; message?: string }
  | { type: "shutting-down" }
  | { type: "error"; message: string; sessionId?: string };

/**
 * Events streamed during a turn. Mirrors AgentEvent but simplified for
 * IPC transport.
 */
export type TurnStreamEvent =
  | { type: "token"; text: string }
  | { type: "tool_call_start"; name: string; args: unknown }
  | { type: "tool_call_done"; name: string; result: string }
  | { type: "tool_call_error"; name: string; error: string };

/** Token usage included in turn-complete responses. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Whether a response frame is terminal (i.e. the last frame for a request).
 * Only `turn-event` is intermediate — everything else terminates the
 * exchange, including unknown response types from older daemon versions
 * (e.g. legacy `turn-accepted`).
 */
export function isTerminalResponse(resp: IpcResponse): boolean {
  return resp.type !== "turn-event";
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  origin: SessionOrigin;
  status: "active" | "idle" | "ended";
  createdAt: string;
  lastActiveAt: string;
  model: string;
  turnsCompleted: number;
  inMemory: boolean;
}

export interface DaemonStatusInfo {
  pid: number;
  uptime: number;
  startTime: string;
  model: string;
  gateways: string;
  lastErrors: string[];
  sessionsActive: number;
  turnsCompleted: number;
}

/**
 * JSON-serializable message representation for IPC transport.
 * pi-ai's Message type uses complex content arrays; for IPC we serialize
 * to plain JSON and deserialize on the receiving end.
 */
export type SerializedMessage = Message;

/* ─── Daemon Config ─── */

export interface DaemonConfig {
  /** Model defaults (provider, model id, alias). */
  defaultModel?: {
    provider: string;
    model: string;
    alias?: string;
  };
  /** Enabled gateway names (e.g. ["whatsapp"]). Empty array = none. */
  gateways: string[];
  /** Skill names to enable. */
  skills: string[];
  /** Memory settings. */
  memory: {
    /** Whether ambient memory hints are enabled. */
    ambientHints: boolean;
    /** Maximum number of hints per turn. */
    maxHints: number;
  };
  /** Log retention in days. */
  logRetentionDays: number;
  /** Heartbeat interval in seconds (0 = disabled). */
  heartbeatIntervalSec: number;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  gateways: [],
  skills: [],
  memory: {
    ambientHints: true,
    maxHints: 5,
  },
  logRetentionDays: 14,
  heartbeatIntervalSec: 0,
};
