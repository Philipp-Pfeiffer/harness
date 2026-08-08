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
  ChannelSendPayload,
  ChannelFileCapabilities,
} from "../daemon/types.js";
import type { HarnessPaths } from "@harness/core";
import {
  createWhatsAppClient,
  type WhatsAppClient,
  type BaileysMessage,
  type WAMessage,
} from "./client.js";
import { downloadContentFromMessage } from "baileys";
import type { DownloadableMessage } from "baileys";
import { isWhitelisted, resolveSenderName, extractPhoneNumber } from "./whitelist.js";
import {
  downloadMedia,
  processMediaForTurn,
  isVisionCapableModel,
  MediaTooLargeError,
} from "./media.js";
import { transcribeVoice } from "./voice.js";
import { sendAgentResponse } from "./outbound.js";
import { WhatsAppInboundProcessor } from "./inbound.js";
import { getCapabilities } from "../output/capabilities.js";
import type { Model, Api } from "@mariozechner/pi-ai";

/** Options for creating the WhatsApp plugin. */
export interface WhatsAppPluginOptions {
  paths: HarnessPaths;
  phoneNumber: string;
  testMode: boolean;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
  model: Model<Api> | null;
  /** Whether the model supports vision (from config, overrides name heuristics). */
  modelSupportsVision?: boolean;
  callbacks: {
    submitTurn: (sessionId: string, text: string, imageBlocks?: import("../daemon/types.js").InboundImageBlock[]) => Promise<{ finalResponse: string }>;
    compactSession: (sessionId: string) => Promise<void>;
    rotateSessionForInactivity: (source: string, sessionId: string) => Promise<string>;
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
          rotateSessionForInactivity: opts.callbacks.rotateSessionForInactivity,
          resolveSession: opts.callbacks.resolveSession,
          sendOutbound: async (target, markdown) => {
            if (!client) return;
            try {
              await sendAgentResponse(
                target,
                markdown,
                async (jid, payload) => {
                  if (payload.text) {
                    await client!.sendMessage(jid, payload.text);
                  }
                  if (payload.files) {
                    for (const file of payload.files) {
                      if (file.buffer) {
                        await client!.sendFile(jid, { buffer: file.buffer, mimeType: file.mimeType, caption: file.caption, asSticker: file.asSticker });
                      } else if (file.path) {
                        await client!.sendFile(jid, { path: file.path, mimeType: file.mimeType, caption: file.caption, asSticker: file.asSticker });
                      }
                    }
                  }
                },
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
        onMessage: (msg) => handleInboundMessage(msg, opts, processor, client),
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

    async sendMessage(target: string, payload: ChannelSendPayload): Promise<void> {
      if (!client) throw new Error("WhatsApp client not started");

      // Send text
      if (payload.text) {
        await client.sendMessage(target, payload.text);
      }

      // Send files
      if (payload.files) {
        for (const file of payload.files) {
          if (file.buffer) {
            await client.sendFile(target, { buffer: file.buffer, mimeType: file.mimeType, caption: file.caption, asSticker: file.asSticker });
          } else if (file.path) {
            await client.sendFile(target, { path: file.path, mimeType: file.mimeType, caption: file.caption, asSticker: file.asSticker });
          }
        }
      }
    },

    getFileCapabilities(): ChannelFileCapabilities {
      const caps = getCapabilities("whatsapp");
      return {
        supportedMimePrefixes: [...caps.supportedFilePrefixes],
        supportsSticker: caps.supportsSticker,
        maxFileSize: caps.maxFileSize,
      };
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
  client: { resolveLidToPn: (lid: string) => Promise<string | null>; markAsRead: (jid: string, messageKeys: string[]) => Promise<void>; sendTyping: (jid: string) => Promise<void> } | null,
): Promise<void> {
  if (!processor) return;

  const jid = msg.rawJid || msg.key.remoteJid || "";
  let source = extractPhoneNumber(jid);

  // For group messages (@g.us), the real sender is in key.participant
  let effectiveJid = jid;
  if (jid.includes("@g.us") && msg.key.participant) {
    effectiveJid = msg.key.participant;
    source = extractPhoneNumber(effectiveJid);
  }

  // Baileys 7.x uses @lid JIDs (Linked Identity) instead of @s.whatsapp.net
  // Resolve LID → phone number JID for whitelist check
  if (effectiveJid.includes("@lid")) {
    // Try participant first (for group messages with LID)
    if (msg.key.participant && msg.key.participant.includes("@lid")) {
      effectiveJid = msg.key.participant;
      source = extractPhoneNumber(effectiveJid);
    }

    // Use Baileys' LID mapping store to resolve to PN
    if (effectiveJid.includes("@lid") && client) {
      const pn = await client.resolveLidToPn(effectiveJid);
      if (pn) {
        opts.log(`LID resolved: ${effectiveJid} → ${pn}`, "info");
        effectiveJid = pn;
        source = extractPhoneNumber(effectiveJid);
      } else {
        opts.log(`LID resolution failed for ${effectiveJid} (pushName: ${msg.pushName})`, "warn");
      }
    }
  }

  const isGroup = jid.includes("@g.us");
  opts.log(`Inbound: JID=${jid}${isGroup ? " (group)" : ""}, effective=${effectiveJid}, source=${source}, pushName=${msg.pushName}`, "info");

  // Whitelist check — silent drop for non-whitelisted
  if (!isWhitelisted(effectiveJid)) {
    opts.log(`Silent drop: non-whitelisted message from ${source} (JID: ${jid}, effective: ${effectiveJid})`, "info");
    return;
  }

  // Mark message as read immediately (before processing, so it's fast)
  if (client && msg.key.id) {
    try {
      await client.markAsRead(jid, [msg.key.id]);
    } catch {
      // Non-critical — don't fail the turn
    }
  }

  // Send typing indicator immediately (before media download / transcription)
  if (client) {
    try {
      await client.sendTyping(jid);
    } catch {
      // Non-critical
    }
  }

  const waMessage = msg.message;
  if (!waMessage) {
    // No message content — ignore
    return;
  }

  const timestamp = new Date(msg.messageTimestamp * 1000).toISOString();
  // Use effectiveJid as source — outbound replies go to this JID
  // (LID for LID chats, PN for PN chats)
  const event = await parseBaileysMessage(waMessage, effectiveJid, timestamp, opts, msg);

  if (event) {
    event.senderName = resolveSenderName(effectiveJid);
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
      const buffer = await downloadFromBaileys(message.imageMessage, rawMsg, "image");
      const media = await downloadMedia(buffer, message.imageMessage.mimetype ?? "image/jpeg", "image", mediaDir);
      mediaArray.push(media);

      // Vision check
      if (opts.model && isVisionCapableModel({ name: opts.model.name, provider: (opts.model as any).provider ?? "", supportsVision: opts.modelSupportsVision })) {
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
      const buffer = await downloadFromBaileys(message.videoMessage, rawMsg, "video");
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
    // Baileys 7.x: ptt flag may be unreliable. Treat all audio messages as
    // potential voice notes and attempt transcription. The mimeType (audio/ogg)
    // is the most reliable indicator for WhatsApp voice notes.
    const isOgg = (message.audioMessage.mimetype ?? "").includes("ogg");
    const ptt = message.audioMessage.ptt === true || isOgg;
    log(`Audio message: ptt=${message.audioMessage.ptt} isOgg=${isOgg} → treatingAsVoice=${ptt} mimeType=${message.audioMessage.mimetype} seconds=${message.audioMessage.seconds}`, "info");
    try {
      const buffer = await downloadFromBaileys(message.audioMessage, rawMsg, "audio");
      const mediaType = ptt ? "voice" : "audio";
      const media = await downloadMedia(buffer, message.audioMessage.mimetype ?? "audio/ogg", mediaType as InboundMedia["type"], mediaDir);

      if (ptt) {
        // Voice note → transcribe
        const transcript = await transcribeVoice(media.filePath);
        if (transcript) {
          // Transkript als Text liefern, Media NICHT zu mediaArray hinzufügen
          // (Agent bekommt den Text, nicht die Datei-Annotation)
          text = `[Voice-Nachricht] ${transcript}`;
          isVoiceTranscript = true;
        } else {
          // Transkription fehlgeschlagen → Datei-Annotation
          mediaArray.push(media);
          annotations.push(
            `Voice-Nachricht empfangen, Transkription nicht verfügbar. Datei: ${media.filePath}`,
          );
        }
      } else {
        // Audio-Datei (kein Voice-Note) → normale Media-Behandlung
        mediaArray.push(media);
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
      const buffer = await downloadFromBaileys(message.documentMessage, rawMsg, "document");
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
      const buffer = await downloadFromBaileys(message.stickerMessage, rawMsg, "sticker");
      const media = await downloadMedia(buffer, message.stickerMessage.mimetype ?? "image/webp", "sticker", mediaDir);
      mediaArray.push(media);
      log(`Sticker received from ${source}: ${media.filePath}`, "info");
      // Return event with media but no text — test mode echoes, normal mode ignores
      return {
        channel: "whatsapp",
        source,
        text: "",
        timestamp,
        media: mediaArray,
        imageBlocks: [],
        annotations: undefined,
        isVoiceTranscript: false,
      };
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        log(`Sticker too large: ${err.actualSize} bytes`, "warn");
      } else {
        log(`Sticker download failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }
    return null;
  }

  // Build media annotations for non-sticker media
  if (mediaArray.length > 0) {
    const visionCapable = opts.model
      ? isVisionCapableModel({ name: opts.model.name, provider: (opts.model as any).provider ?? "", supportsVision: opts.modelSupportsVision })
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
 * Uses Baileys' downloadContentFromMessage which doesn't need socket context.
 * @param mediaType - "image" | "video" | "audio" | "sticker" | "document"
 */
async function downloadFromBaileys(
  proto: DownloadableMessage | Record<string, unknown>,
  _rawMsg: BaileysMessage,
  mediaType: "image" | "video" | "audio" | "sticker" | "document",
): Promise<Buffer> {
  const stream = await downloadContentFromMessage(proto as DownloadableMessage, mediaType);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
