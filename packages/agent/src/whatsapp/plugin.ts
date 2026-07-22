/**
 * WhatsApp Channel Plugin.
 *
 * Implements ChannelPlugin: bridges Baileys WhatsApp transport to the
 * Harness daemon. Handles:
 * - Baileys connection lifecycle (pairing, persistence, reconnect)
 * - Inbound message parsing (text, media, voice, sticker)
 * - Media download + voice transcription
 * - Whitelist enforcement
 * - Routing to the daemon's inbound processor
 * - Outbound message sending via the output pipeline
 */

import { join } from "node:path";
import type {
  ChannelPlugin,
  ChannelInboundEvent,
  InboundMedia,
} from "../daemon/types.js";
import type { HarnessPaths } from "@harness/core";
import {
  createWhatsAppClient,
  type WhatsAppClient,
  type BaileysMessage,
  type WAMessage,
} from "./client.js";
import { isWhitelisted, extractPhoneNumber } from "./whitelist.js";
import {
  downloadMedia,
  processMediaForTurn,
  isVisionCapableModel,
  MediaTooLargeError,
} from "./media.js";
import { transcribeVoice } from "./voice.js";
import { sendAgentResponse } from "./outbound.js";
import { WhatsAppInboundProcessor } from "./inbound.js";
import type { Model, Api } from "@mariozechner/pi-ai";

/** Options for creating the WhatsApp plugin. */
export interface WhatsAppPluginOptions {
  paths: HarnessPaths;
  phoneNumber: string;
  testMode: boolean;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
  model: Model<Api> | null;
  callbacks: {
    submitTurn: (sessionId: string, text: string, imageBlocks?: import("../daemon/types.js").InboundImageBlock[]) => Promise<{ finalResponse: string }>;
    compactSession: (sessionId: string) => Promise<void>;
    resolveSession: (source: string) => Promise<string>;
    steer: (sessionId: string, text: string) => void;
    checkToolExecuted: (sessionId: string) => boolean;
  };
}

/**
 * Creates a WhatsApp ChannelPlugin instance.
 * The plugin is started by the daemon's registerGateway() call.
 */
export function createWhatsAppPlugin(opts: WhatsAppPluginOptions): ChannelPlugin {
  const authDir = join(opts.paths.whatsapp, "auth");

  let client: WhatsAppClient | null = null;
  let processor: WhatsAppInboundProcessor | null = null;

  return {
    name: "whatsapp",
    channel: "whatsapp",

    async start(): Promise<void> {
      // Initialize the inbound processor
      processor = new WhatsAppInboundProcessor({
        log: opts.log,
        testMode: opts.testMode,
        callbacks: {
          submitTurn: opts.callbacks.submitTurn,
          compactSession: opts.callbacks.compactSession,
          resolveSession: opts.callbacks.resolveSession,
          sendOutbound: async (target, markdown) => {
            if (!client) return;
            try {
              await sendAgentResponse(
                target,
                markdown,
                (jid, text) => client!.sendMessage(jid, text),
                opts.log,
              );
            } catch (err) {
              opts.log(`Outbound send failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            }
          },
          steer: opts.callbacks.steer,
          checkToolExecuted: opts.callbacks.checkToolExecuted,
        },
      });

      // Create and start the Baileys client
      client = createWhatsAppClient({
        authDir,
        phoneNumber: opts.phoneNumber,
        log: opts.log,
        onMessage: (msg) => handleInboundMessage(msg, opts, processor),
        onConnectionUpdate: (update) => {
          if (update.status === "open") {
            opts.log("WhatsApp connected", "info");
          } else if (update.status === "close") {
            opts.log(`WhatsApp disconnected (reason: ${update.disconnectReason ?? "unknown"})`, "warn");
          } else if (update.pairingCode) {
            opts.log(`WhatsApp pairing code: ${update.pairingCode}`, "info");
          }
        },
      });

      await client.start();
    },

    async stop(): Promise<void> {
      if (client) {
        await client.stop();
        client = null;
      }
    },

    async healthCheck(): Promise<boolean> {
      return client?.isConnected() ?? false;
    },

    onInbound(_handler): void {
      // Inbound is handled internally by the plugin's processor.
      // This method exists to satisfy the GatewayAdapter interface.
      // The daemon's routing happens via the callbacks passed in options.
    },

    async sendMessage(target: string, payload: { text: string; attachments?: InboundMedia[] }): Promise<void> {
      if (!client) throw new Error("WhatsApp client not started");
      await client.sendMessage(target, payload.text);
    },
  };
}

/**
 * Handles a raw inbound Baileys message: parses type, downloads media,
 * transcribes voice, and forwards to the inbound processor.
 */
async function handleInboundMessage(
  msg: BaileysMessage,
  opts: WhatsAppPluginOptions,
  processor: WhatsAppInboundProcessor | null,
): Promise<void> {
  if (!processor) return;

  const jid = msg.key.remoteJid ?? "";
  const source = extractPhoneNumber(jid);

  // Whitelist check — silent drop for non-whitelisted
  if (!isWhitelisted(jid)) {
    opts.log(`Silent drop: non-whitelisted message from ${source}`, "info");
    return;
  }

  const waMessage = msg.message;
  if (!waMessage) {
    // No message content — ignore
    return;
  }

  const timestamp = new Date(msg.messageTimestamp * 1000).toISOString();
  const event = await parseBaileysMessage(waMessage, source, timestamp, opts, msg);

  if (event) {
    await processor.processInbound(event);
  }
}

/**
 * Parses a Baileys message into a ChannelInboundEvent.
 * Handles text, image, video, audio (voice), document, sticker.
 */
async function parseBaileysMessage(
  message: NonNullable<WAMessage["message"]>,
  source: string,
  timestamp: string,
  opts: WhatsAppPluginOptions,
  rawMsg: BaileysMessage,
): Promise<ChannelInboundEvent | null> {
  const log = opts.log;
  const mediaDir = opts.paths.inboundMedia;
  const annotations: string[] = [];
  const mediaArray: InboundMedia[] = [];
  let text = "";
  let isVoiceTranscript = false;
  let imageBlocks: import("../daemon/types.js").InboundImageBlock[] | undefined;

  // ─── Text message ───
  if (message.conversation) {
    text = message.conversation;
  } else if (message.extendedTextMessage?.text) {
    text = message.extendedTextMessage.text;
  }

  // ─── Image message ───
  if (message.imageMessage) {
    try {
      const buffer = await downloadFromBaileys(message.imageMessage, rawMsg);
      const media = await downloadMedia(buffer, message.imageMessage.mimetype ?? "image/jpeg", "image", mediaDir);
      mediaArray.push(media);

      // Vision check
      if (opts.model && isVisionCapableModel({ name: opts.model.name, provider: (opts.model as any).provider ?? "" })) {
        const { createImageBlock } = await import("./media.js");
        imageBlocks = [await createImageBlock(media.filePath, media.mimeType)];
      }
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        log(`Image too large: ${err.actualSize} bytes`, "warn");
      } else {
        log(`Image download failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }
  }

  // ─── Video message ───
  if (message.videoMessage) {
    try {
      const buffer = await downloadFromBaileys(message.videoMessage, rawMsg);
      const media = await downloadMedia(buffer, message.videoMessage.mimetype ?? "video/mp4", "video", mediaDir);
      mediaArray.push(media);
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        log(`Video too large: ${err.actualSize} bytes`, "warn");
      } else {
        log(`Video download failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }
  }

  // ─── Audio message (voice note or audio file) ───
  if (message.audioMessage) {
    const ptt = message.audioMessage.ptt ?? false;
    try {
      const buffer = await downloadFromBaileys(message.audioMessage, rawMsg);
      const mediaType = ptt ? "voice" : "audio";
      const media = await downloadMedia(buffer, message.audioMessage.mimetype ?? "audio/ogg", mediaType as InboundMedia["type"], mediaDir);
      mediaArray.push(media);

      if (ptt) {
        // Voice note → transcribe
        const transcript = await transcribeVoice(media.filePath);
        if (transcript) {
          text = `[Voice-Nachricht] ${transcript}`;
          isVoiceTranscript = true;
        } else {
          annotations.push(
            `Voice-Nachricht empfangen, Transkription nicht verfügbar. Datei: ${media.filePath}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        log(`Audio too large: ${err.actualSize} bytes`, "warn");
      } else {
        log(`Audio download failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }
  }

  // ─── Document message ───
  if (message.documentMessage) {
    try {
      const buffer = await downloadFromBaileys(message.documentMessage, rawMsg);
      const media = await downloadMedia(buffer, message.documentMessage.mimetype ?? "application/octet-stream", "document", mediaDir);
      mediaArray.push(media);
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        log(`Document too large: ${err.actualSize} bytes`, "warn");
      } else {
        log(`Document download failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }
  }

  // ─── Sticker message ───
  if (message.stickerMessage) {
    try {
      const buffer = await downloadFromBaileys(message.stickerMessage, rawMsg);
      const media = await downloadMedia(buffer, message.stickerMessage.mimetype ?? "image/webp", "sticker", mediaDir);
      mediaArray.push(media);
      // v1: log + save, no turn
      log(`Sticker received from ${source}: ${media.filePath}`, "info");
      return null; // No turn for stickers
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        log(`Sticker too large: ${err.actualSize} bytes`, "warn");
      } else {
        log(`Sticker download failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }
    return null; // No turn for stickers even on download failure
  }

  // Build media annotations for non-sticker media
  if (mediaArray.length > 0) {
    const visionCapable = opts.model
      ? isVisionCapableModel({ name: opts.model.name, provider: (opts.model as any).provider ?? "" })
      : false;
    const { annotations: mediaAnnotations } = await processMediaForTurn(mediaArray, visionCapable);
    annotations.push(...mediaAnnotations);
  }

  // If no text and no media → ignore
  if (!text && mediaArray.length === 0) {
    return null;
  }

  return {
    channel: "whatsapp",
    source,
    text,
    timestamp,
    media: mediaArray.length > 0 ? mediaArray : undefined,
    imageBlocks,
    annotations: annotations.length > 0 ? annotations : undefined,
    isVoiceTranscript,
  };
}

/**
 * Downloads media content from a Baileys message component.
 * Uses the download() method available on Baileys proto messages.
 */
async function downloadFromBaileys(
  proto: { download?: () => Promise<Buffer> } | unknown,
  _rawMsg: BaileysMessage,
): Promise<Buffer> {
  // Baileys proto messages have a download() method
  const downloadFn = (proto as { download?: () => Promise<Buffer> }).download;
  if (!downloadFn) {
    throw new Error("Media has no download function — Baileys socket not available");
  }
  return downloadFn.call(proto);
}
