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

/* ─── IPC Protocol (Unix socket) ─── */

export type IpcRequest =
  | { type: "ping" }
  | { type: "status" }
  | { type: "submit-turn"; messages: SerializedMessage[]; model?: string }
  | { type: "reload-config" }
  | { type: "shutdown" };

export type IpcResponse =
  | { type: "pong"; uptime: number; pid: number }
  | { type: "status"; daemon: DaemonStatusInfo }
  | { type: "turn-accepted"; info: string }
  | { type: "config-reloaded"; ok: boolean; message?: string }
  | { type: "shutting-down" }
  | { type: "error"; message: string };

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
