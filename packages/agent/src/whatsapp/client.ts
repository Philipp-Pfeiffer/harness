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
  DisconnectReason,
  type WASocket,
  type AuthenticationCreds,
  type WAMessage,
} from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import {
  RECONNECT_BACKOFF_BASE_MS,
  RECONNECT_BACKOFF_MAX_MS,
} from "./limits.js";
import { isRealtimeInboundUpsert } from "./sessionPolicy.js";
import type { MessageUpsertType, WAPresence } from "baileys";

/** Re-export WAMessage as the message type (Baileys' WebMessageInfo equivalent). */
export type { WAMessage, DisconnectReason, WAPresence };

/** Prints a QR code to the terminal as ANSI art and saves PNG to ~/Downloads. */
function printQRCode(qr: string): void {
  const ascii = QRCode.toString(qr, { type: "terminal", small: true });
  ascii.then((code) => {
    console.log("\n" + code + "\n");
  }).catch(() => {
    console.log(`\nQR raw: ${qr}\n`);
  });
  // Also save as PNG for easy scanning
  const outPath = join(process.env.HOME ?? "/tmp", "Downloads", "whatsapp-qr.png");
  QRCode.toFile(outPath, qr, { width: 400, margin: 2 }).then(() => {
    console.log(`\nQR code saved to ${outPath}\n`);
  }).catch((err) => {
    console.log(`\nFailed to save QR PNG: ${err}\n`);
  });
}

/** Simplified inbound message from Baileys. */
export interface BaileysMessage {
  key: WAMessage["key"];
  message: WAMessage["message"];
  messageTimestamp: number;
  pushName: string;
  /** Raw remoteJid for LID resolution. */
  rawJid: string;
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
  /** Explicitly unlinks the device from the WhatsApp account (invalidates the session server-side). Requires re-pairing afterwards. */
  logout(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  sendFile(jid: string, file: { buffer?: Buffer; path?: string; mimeType: string; caption?: string; asSticker?: boolean }): Promise<void>;
  getPairingCode(): string | null;
  isConnected(): boolean;
  /** Resolves a LID JID to a phone-number JID (s.whatsapp.net). */
  resolveLidToPn(lid: string): Promise<string | null>;
  /** Marks messages as read (blue ticks). */
  markAsRead(jid: string, messageKeys: string[]): Promise<void>;
  /**
   * Sends a presence update to a chat or — without jid — the account-wide
   * presence ("available"/"unavailable" = online status of the device).
   */
  sendPresenceUpdate(type: WAPresence, jid?: string): Promise<void>;
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
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Print QR code to terminal for scanning
        opts.log(`QR code received — scan with WhatsApp`, "info");
        printQRCode(qr);
      }

      if (connection === "connecting") {
        opts.onConnectionUpdate({ status: "connecting" });
      } else if (connection === "open") {
        connected = true;
        reconnectAttempts = 0;
        opts.onConnectionUpdate({ status: "open" });
        opts.log("WhatsApp connected", "info");
      } else if (connection === "close") {
        connected = false;
        const error = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const statusCode = error?.output?.statusCode;
        opts.onConnectionUpdate({ status: "close", disconnectReason: statusCode });

        if (statusCode === DisconnectReason.loggedOut) {
          // Session invalidated server-side — reconnecting is pointless,
          // a new pairing (QR scan) is required.
          opts.log("WhatsApp session invalidated (logged out) — re-pairing required", "error");
        } else if (!stopped) {
          // Reconnect with backoff
          scheduleReconnect();
        }
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }: { messages: WAMessage[]; type: MessageUpsertType }) => {
      if (!isRealtimeInboundUpsert(type)) {
        return;
      }
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
          rawJid: msg.key.remoteJid ?? "",
        });
      }
    });

    sock.ev.on("messages.update", (updates) => {
      for (const update of updates) {
        const status = update.update?.status;
        if (status !== undefined) {
          opts.log(
            `msg-update id=${update.key.id} remoteJid=${update.key.remoteJid} status=${status} participant=${update.key.participant ?? "-"}`,
            "info",
          );
        }
      }
    });

    // QR code is printed to terminal by Baileys (printQRInTerminal: true).
    // No pairing code request needed.
    if (!state.creds.registered) {
      opts.log("Waiting for QR scan…", "info");
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
        // Close the connection WITHOUT logout — logout() would invalidate the
        // session server-side and force a QR re-scan on the next start.
        sock.end(undefined);
        sock = null;
      }
      connected = false;
    },

    async logout(): Promise<void> {
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
      const rawBuffer = file.buffer ?? (file.path ? await readFile(file.path) : undefined);
      if (!rawBuffer) throw new Error("sendFile requires either buffer or path");
      // Ensure it's a proper Buffer (Baileys expects Buffer, not Uint8Array)
      const buffer = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);

      const messageType = baileysMessageType(file.mimeType, file.asSticker ?? false);
      // Baileys expects the media on the message type key, not nested under `data`.
      // For documents we must also provide mimetype and fileName at top level.
      const message: Record<string, unknown> = {
        [messageType]: buffer,
      };
      if (messageType === "document") {
        message.mimetype = file.mimeType;
        message.fileName = file.path ? basename(file.path) : "file";
      }
      if (file.caption && !file.asSticker) {
        message.caption = file.caption;
      }

      await sock.sendMessage(jid, message as never);
    },

    getPairingCode(): string | null {
      return pairingCode;
    },

    isConnected(): boolean {
      return connected;
    },

    async resolveLidToPn(lid: string): Promise<string | null> {
      if (!sock) return null;
      try {
        // Baileys exposes signalRepository.lidMapping on the socket
        const repo = (sock as unknown as { signalRepository?: { lidMapping?: { getPNForLID: (lid: string) => Promise<string | null> } } }).signalRepository;
        if (!repo?.lidMapping) {
          opts.log("LID mapping store not available on socket", "warn");
          return null;
        }
        const pn = await repo.lidMapping.getPNForLID(lid);
        return pn ?? null;
      } catch (err) {
        opts.log(`LID resolution failed for ${lid}: ${err instanceof Error ? err.message : String(err)}`, "warn");
        return null;
      }
    },

    async markAsRead(jid: string, _messageKeys: string[]): Promise<void> {
      if (!sock) return;
      try {
        await sock.readMessages([{ remoteJid: jid, id: _messageKeys[0], fromMe: false }]);
      } catch (err) {
        opts.log(`Failed to mark as read: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    },

    async sendPresenceUpdate(type: WAPresence, jid?: string): Promise<void> {
      if (!sock) return;
      try {
        await sock.sendPresenceUpdate(type, jid);
      } catch (err) {
        opts.log(`Failed to send presence update (${type}): ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
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
    async logout(): Promise<void> {},
    async sendMessage(_jid: string, _text: string): Promise<void> {},
    async sendFile(_jid: string, _file: { buffer?: Buffer; path?: string; mimeType: string; caption?: string; asSticker?: boolean }): Promise<void> {},
    getPairingCode(): string | null {
      return null;
    },
    isConnected(): boolean {
      return false;
    },
    async resolveLidToPn(_lid: string): Promise<string | null> {
      return null;
    },
    async markAsRead(_jid: string, _messageKeys: string[]): Promise<void> {},
    async sendPresenceUpdate(_type: WAPresence, _jid?: string): Promise<void> {},
  };
}

export function baileysMessageType(mimeType: string, asSticker: boolean): string {
  if (asSticker) return "sticker";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}
