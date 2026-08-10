import type { Message } from "@mariozechner/pi-ai";
import type { SessionStatus, SessionOrigin } from "../core/session.js";

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
  /** Optional media attachments associated with the message. */
  media?: InboundMedia[];
  /** Optional image content blocks for vision-capable models. */
  imageBlocks?: InboundImageBlock[];
  /** Optional annotations (file references, transcription results, etc.). */
  annotations?: string[];
}

/** A media attachment downloaded from the transport. */
export interface InboundMedia {
  /** Local file path where the media was saved. */
  filePath: string;
  /** MIME type of the media. */
  mimeType: string;
  /** File size in bytes. */
  size: number;
  /** Media type category. */
  type: "image" | "audio" | "video" | "document" | "sticker" | "voice";
}

/** An image content block for direct injection into the agent turn. */
export interface InboundImageBlock {
  /** MIME type of the image. */
  mimeType: string;
  /** Raw image data. */
  data: Buffer;
}

/* ─── Channel Plugin Interface ─── */

/**
 * Higher-level gateway interface that includes outbound message rendering.
 * Extends GatewayAdapter with channel-specific message sending.
 *
 * The daemon's plugin registry holds ChannelPlugin instances; WhatsApp
 * is the first implementation.
 */
export interface ChannelPlugin extends GatewayAdapter {
  /** Channel identifier for output-pipeline capability selection. */
  readonly channel: string;
  /** Send a structured payload (text and/or files) to a target. */
  sendMessage(target: string, payload: ChannelSendPayload): Promise<void>;
  /** Returns the file-type capabilities of this channel. */
  getFileCapabilities?(): ChannelFileCapabilities;
  /**
   * Sets presence: account-wide "available"/"unavailable" (online status)
   * or per-chat "composing"/"paused" (typing indicator). Optional — channels
   * without presence reporting can omit it.
   */
  setPresence?(type: "available" | "unavailable" | "composing" | "paused", jid?: string): Promise<void>;
}

/** A file to send via the channel. */
export interface ChannelFile {
  /** Local file path. Mutually exclusive with `buffer`. */
  path?: string;
  /** Raw file data. Mutually exclusive with `path`. */
  buffer?: Buffer;
  /** MIME type of the file. */
  mimeType: string;
  /** Optional caption / text accompanying the file. */
  caption?: string;
  /** Send as sticker (WebP). Only supported if the channel supports stickers. */
  asSticker?: boolean;
}

/** Structured payload for channel.sendMessage(). */
export interface ChannelSendPayload {
  /** Text content. */
  text?: string;
  /** Files to send. */
  files?: ChannelFile[];
}

/** File-type capabilities of a channel. */
export interface ChannelFileCapabilities {
  /** Supported file MIME type prefixes (e.g. "image/", "audio/", "video/", "application/pdf"). */
  supportedMimePrefixes: string[];
  /** Whether the channel supports stickers. */
  supportsSticker: boolean;
  /** Max file size in bytes (0 = unlimited). */
  maxFileSize: number;
}

/**
 * Context provided to a ChannelPlugin at start time.
 * Gives the plugin access to daemon-level callbacks and configuration.
 */
export interface ChannelPluginContext {
  /** Logger function for structured logging. */
  log: (msg: string, level?: "info" | "warn" | "error") => void;
  /** Paths for file I/O (media storage, session persistence, etc.). */
  paths: import("@harness/core").HarnessPaths;
  /** Whether the plugin should run in test mode (no agent turns, echo only). */
  testMode: boolean;
  /**
   * Callback for posting an inbound event into the daemon's routing layer.
   * The daemon resolves session, runs debounce/abort logic, and dispatches
   * to the agent loop.
   */
  onInboundEvent: (event: ChannelInboundEvent) => void;
  /** Register an outbound handler — called when the daemon has a response to send. */
  onOutbound: (handler: (target: string, messages: import("../output/index.js").RenderedMessage[]) => Promise<void>) => void;
}

/**
 * Structured inbound event from a channel plugin.
 * The daemon's routing layer processes this to determine session routing,
 * debounce, abort-and-restart, and agent turn submission.
 */
export interface ChannelInboundEvent {
  /** Channel plugin id (e.g. "whatsapp"). */
  channel: string;
  /** Source identifier (phone number, chat id). */
  source: string;
  /** Display name of the sender (from whitelist map, or formatted phone number). */
  senderName?: string;
  /** Text content for the agent turn. */
  text: string;
  /** ISO timestamp of receipt. */
  timestamp: string;
  /** Media attachments. */
  media?: InboundMedia[];
  /** Image content blocks for vision. */
  imageBlocks?: InboundImageBlock[];
  /** Annotations to append to the turn text. */
  annotations?: string[];
  /** Whether this event is a voice message transcription. */
  isVoiceTranscript?: boolean;
}

/* ─── Session Scope ─── */

/**
 * Session scope concept: multiple channels can route to the same session.
 * MVP: one persistent session per chat (source identifier).
 */
export interface SessionScope {
  /** Channel that owns this scope. */
  channel: string;
  /** Source identifier within the channel. */
  source: string;
  /** Resolved session ID (persisted across daemon restarts). */
  sessionId: string;
}

/* ─── Session Origin ─── */

export type { SessionStatus, SessionOrigin } from "../core/session.js";

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
  | { type: "create-session"; origin?: SessionOrigin; title?: string; model?: string; profile?: string }
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
  | { type: "session-created"; sessionId: string; origin: SessionOrigin; createdAt: string; profile?: string }
  | { type: "sessions-listed"; sessions: SessionSummary[] }
  | { type: "session-resumed"; sessionId: string; messageCount: number }
  | { type: "session-ended"; sessionId: string }
  | { type: "turn-event"; sessionId: string; event: TurnStreamEvent }
  | { type: "turn-complete"; sessionId: string; finalResponse: string; info: string; turnsCompleted: number; aborted?: boolean; usage?: TurnUsage }
  | { type: "config-reloaded"; ok: boolean; message?: string }
  | { type: "shutting-down" }
  | { type: "error"; message: string; sessionId?: string };

/**
 * Events streamed during a turn. Mirrors AgentEvent but simplified for
 * IPC transport.
 */
export type TurnStreamEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call_start"; name: string; args: unknown }
  | { type: "tool_call_done"; name: string; result: string }
  | { type: "tool_call_error"; name: string; error: string }
  | { type: "status"; status: string };

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
  status: SessionStatus;
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
  /** WhatsApp gateway configuration. */
  whatsapp?: WhatsAppConfig;
}

/** WhatsApp gateway configuration. */
export interface WhatsAppConfig {
  /** Test mode: no agent turns, echo only. */
  testMode: boolean;
  /** Phone number for pairing (JID format: number@s.whatsapp.net). */
  phoneNumber: string;
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
