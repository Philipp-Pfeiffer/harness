/**
 * WhatsApp Baileys Client Wrapper.
 *
 * Handles pairing-code auth, session persistence, reconnection with backoff,
 * and inbound message filtering (not-fromMe only).
 *
 * Exports a mock client for testing that has the same interface but never
 * connects to WhatsApp.
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type AuthenticationCreds,
  type WAMessage,
  type DisconnectReason,
} from "baileys";
import pino from "pino";
import { readFile } from "node:fs/promises";
import {
  RECONNECT_BACKOFF_BASE_MS,
  RECONNECT_BACKOFF_MAX_MS,
} from "./limits.js";

/** Re-export WAMessage as the message type (Baileys' WebMessageInfo equivalent). */
export type { WAMessage, DisconnectReason };

/** Simplified inbound message from Baileys. */
export interface BaileysMessage {
  key: WAMessage["key"];
  message: WAMessage["message"];
  messageTimestamp: number;
  pushName: string;
}

/** Connection status update from the client. */
export interface ConnectionUpdate {
  status: "connecting" | "open" | "close" | "connecting_phone";
  pairingCode?: string;
  disconnectReason?: number;
}

/** Options for creating a WhatsApp client. */
export interface WhatsAppClientOptions {
  authDir: string;
  phoneNumber: string;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
  onMessage: (msg: BaileysMessage) => void;
  onConnectionUpdate: (update: ConnectionUpdate) => void;
}

/** WhatsApp client interface. */
export interface WhatsAppClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  sendFile(jid: string, file: { buffer?: Buffer; path?: string; mimeType: string; caption?: string; asSticker?: boolean }): Promise<void>;
  getPairingCode(): string | null;
  isConnected(): boolean;
}

/**
 * Creates a WhatsApp client backed by Baileys.
 *
 * Uses pairing-code auth (no QR code). Session is persisted in authDir
 * via useMultiFileAuthState — no re-pairing needed on daemon restart.
 */
export function createWhatsAppClient(opts: WhatsAppClientOptions): WhatsAppClient {
  let sock: WASocket | null = null;
  let pairingCode: string | null = null;
  let connected = false;
  let stopped = false;
  let reconnectAttempts = 0;

  async function connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(opts.authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: { creds: state.creds as AuthenticationCreds, keys: state.keys },
      printQRInTerminal: false,
      browser: ["Harness", "Chrome", "1.0.0"],
      logger: pino({ level: "warn" }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "connecting") {
        opts.onConnectionUpdate({ status: "connecting" });
      } else if (connection === "open") {
        connected = true;
        reconnectAttempts = 0;
        opts.onConnectionUpdate({ status: "open" });
      } else if (connection === "close") {
        connected = false;
        const error = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const statusCode = error?.output?.statusCode;
        opts.onConnectionUpdate({ status: "close", disconnectReason: statusCode });

        if (!stopped) {
          // Reconnect with backoff
          scheduleReconnect();
        }
      }
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) {
        // Only emit inbound messages (not fromMe)
        if (msg.key.fromMe) continue;
        opts.onMessage({
          key: msg.key,
          message: msg.message,
          messageTimestamp: typeof msg.messageTimestamp === "number"
            ? msg.messageTimestamp
            : Date.now(),
          pushName: msg.pushName ?? "",
        });
      }
    });

    // If not yet authenticated, request pairing code
    if (!state.creds.registered) {
      try {
        // Wait for socket to be ready for pairing
        await new Promise<void>((resolve) => {
          const checkReady = setInterval(() => {
            if (sock?.user) {
              clearInterval(checkReady);
              resolve();
            }
          }, 500);
          // Timeout after 30s
          setTimeout(() => {
            clearInterval(checkReady);
            resolve();
          }, 30_000);
        });

        if (sock && !sock.user) {
          const code = await sock.requestPairingCode(opts.phoneNumber);
          pairingCode = code ?? null;
          if (code) {
            opts.log(`Pairing code: ${code}`, "info");
            opts.onConnectionUpdate({ status: "connecting", pairingCode: code });
          }
        }
      } catch (err) {
        opts.log(`Failed to request pairing code: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }
  }

  function scheduleReconnect(): void {
    reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BACKOFF_BASE_MS * Math.pow(2, reconnectAttempts - 1),
      RECONNECT_BACKOFF_MAX_MS,
    );
    opts.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`, "warn");
    setTimeout(() => {
      if (!stopped) {
        connect().catch((err) => {
          opts.log(`Reconnect failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        });
      }
    }, delay);
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      await connect();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (sock) {
        try {
          await sock.logout();
        } catch {
          // Force end if logout fails
          sock.end(undefined);
        }
        sock = null;
      }
      connected = false;
    },

    async sendMessage(jid: string, text: string): Promise<void> {
      if (!sock) throw new Error("WhatsApp client not started");
      await sock.sendMessage(jid, { text });
    },

    async sendFile(jid: string, file: { buffer?: Buffer; path?: string; mimeType: string; caption?: string; asSticker?: boolean }): Promise<void> {
      if (!sock) throw new Error("WhatsApp client not started");
      const buffer = file.buffer ?? (file.path ? await readFile(file.path) : undefined);
      if (!buffer) throw new Error("sendFile requires either buffer or path");

      const messageType = baileysMessageType(file.mimeType, file.asSticker ?? false);
      const content: Record<string, unknown> = { mimetype: file.mimeType, data: buffer };

      if (file.caption && !file.asSticker) {
        content.caption = file.caption;
      }

      await sock.sendMessage(jid, { [messageType]: content } as never);
    },

    getPairingCode(): string | null {
      return pairingCode;
    },

    isConnected(): boolean {
      return connected;
    },
  };
}

/**
 * Creates a mock WhatsApp client for testing.
 * Implements the same interface but never connects to WhatsApp.
 */
export function createMockWhatsAppClient(): WhatsAppClient {
  return {
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async sendMessage(_jid: string, _text: string): Promise<void> {},
    async sendFile(_jid: string, _file: { buffer?: Buffer; path?: string; mimeType: string; caption?: string; asSticker?: boolean }): Promise<void> {},
    getPairingCode(): string | null {
      return null;
    },
    isConnected(): boolean {
      return false;
    },
  };
}

/**
 * Maps a MIME type to the Baileys message type key.
 * asSticker=true overrides to 'sticker' for WebP images.
 *
 * @returns The Baileys message content key ('image', 'audio', 'video', 'document', 'sticker').
 */
export function baileysMessageType(mimeType: string, asSticker: boolean): string {
  if (asSticker) return "sticker";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}
