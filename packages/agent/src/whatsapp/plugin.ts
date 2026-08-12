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
import type { DownloadableMessage } from "baileys";
import { isWhitelisted, resolveSenderName, extractPhoneNumber } from "./whitelist.js";
import { downloadMediaContent, type MediaHostSource } from "./mediaDownload.js";
import {
  downloadMedia,
  processMediaForTurn,
  MediaTooLargeError,
} from "./media.js";
import { transcribeVoice, type VoiceErrorReason } from "./voice.js";
import { sendAgentResponse } from "./outbound.js";
import { WhatsAppInboundProcessor } from "./inbound.js";
import { getCapabilities } from "../output/capabilities.js";
import { sha256Hex } from "../stickers/library.js";
import type { Model, Api } from "@mariozechner/pi-ai";

/** Options for creating the WhatsApp plugin. */
export interface WhatsAppPluginOptions {
  paths: HarnessPaths;
  phoneNumber: string;
  testMode: boolean;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
  model: Model<Api> | null;
  callbacks: {
    submitTurn: (sessionId: string, text: string, imageBlocks?: import("../daemon/types.js").InboundImageBlock[], signal?: AbortSignal) => Promise<{ finalResponse: string }>;
    compactSession: (sessionId: string) => Promise<void>;
    rotateSessionForInactivity: (source: string, sessionId: string) => Promise<string>;
    /** Resolve or create a session for a source. Returns whether the session was rotated (>8h). */
    resolveSession: (source: string) => Promise<{ sessionId: string; rotated: boolean }>;
    steer: (sessionId: string, text: string) => void;
    executeCommand: (sessionId: string, text: string) => Promise<{ response: string; newSessionId?: string }>;
    /**
     * Sends a WhatsApp presence update: "available"/"unavailable" for the
     * account-wide online status (no jid), "composing"/"paused" for a chat.
     */
    setPresence: (type: "available" | "unavailable" | "composing" | "paused", jid?: string) => void;
    /** Reports the inbound processor instance back to the daemon (for system event bus). */
    setProcessor?: (processor: WhatsAppInboundProcessor) => void;
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
          setPresence: (type, jid) => {
            if (!client) return;
            client.sendPresenceUpdate(type, jid).catch((err) => {
              opts.log(`Presence update failed (${type}): ${err instanceof Error ? err.message : String(err)}`, "warn");
            });
          },
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
          executeCommand: opts.callbacks.executeCommand,
        },
      });

      // Report processor back to daemon for system event bus
      opts.callbacks.setProcessor?.(processor);

      // Create and start the Baileys client
      client = createWhatsAppClient({
        authDir,
        phoneNumber: opts.phoneNumber,
        log: opts.log,
        onMessage: (msg) => handleInboundMessage(msg, opts, processor, client, client),
        onConnectionUpdate: (update) => {
          if (update.status === "open") {
            opts.log("WhatsApp connected", "info");
            // No explicit "available" here — Baileys sends it itself on connect
            // (markOnlineOnConnect). Sending it again would race the automatic
            // "unavailable" from a concurrent reconnect.
          } else if (update.status === "close") {
            opts.log(`WhatsApp disconnected (reason: ${update.disconnectReason ?? "unknown"})`, "warn");
            void opts.callbacks.setPresence("unavailable");
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

    /**
     * Sets presence: account-wide "available"/"unavailable" (no jid) or
     * per-chat "composing"/"paused" (with jid). Non-critical — failures are
     * handled inside the client wrapper, never fatal.
     */
    async setPresence(type: "available" | "unavailable" | "composing" | "paused", jid?: string): Promise<void> {
      if (!client) return;
      await client.sendPresenceUpdate(type, jid);
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
  client: {
    resolveLidToPn: (lid: string) => Promise<string | null>;
    markAsRead: (jid: string, messageKeys: string[]) => Promise<void>;
  } | null,
  mediaSource: MediaHostSource | null,
): Promise<void> {
  if (!processor) return;

  const jid = msg.rawJid || msg.key.remoteJid || "";
  let source = extractPhoneNumber(jid);

  // Baileys 7.x isJidGroup(): jid.endsWith('@g.us') is exact — LID group
  // JIDs ("…:0@g.us" or "…@lid" group participants) can slip through. The
  // participant JID is the reliable group-membership signal, so treat
  // messages with a participant as group messages.
  const isGroup = jid.includes("@g.us") || (msg.key.participant?.length ?? 0) > 0;

  // For group messages, the real sender is in key.participant
  let effectiveJid = jid;
  if (isGroup && msg.key.participant) {
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
        // Baileys' LID mapping may return a device-specific JID like
        // "4915110619636:0@s.whatsapp.net". The ":0" suffix selects a
        // different session key pair which causes decryption issues on
        // WhatsApp Web. Strip it so outbound messages use the same JID
        // format as the restart/deploy path.
        const cleanPun = pn.replace(/:(\d+)@/, "@");
        if (cleanPun !== pn) {
          opts.log(`LID PN had device suffix, stripped: ${pn} → ${cleanPun}`, "info");
        }
        opts.log(`LID resolved: ${effectiveJid} → ${cleanPun}`, "info");
        effectiveJid = cleanPun;
        source = extractPhoneNumber(effectiveJid);
      } else {
        opts.log(`LID resolution failed for ${effectiveJid} (pushName: ${msg.pushName})`, "warn");
      }
    }
  }

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

  const waMessage = msg.message;
  if (!waMessage) {
    // No message content — ignore
    return;
  }

  const timestamp = new Date(msg.messageTimestamp * 1000).toISOString();
  // Use effectiveJid as source — outbound replies go to this JID
  // (LID for LID chats, PN for PN chats)
  const event = await parseBaileysMessage(waMessage, effectiveJid, timestamp, opts, msg, mediaSource);

  if (event) {
    event.senderName = resolveSenderName(effectiveJid);
    await processor.processInbound(event);
  }
}

/**
 * Parses a Baileys message into a ChannelInboundEvent.
 * Handles text, image, video, audio (voice), document, sticker.
 * Exported for tests.
 */
export async function parseBaileysMessage(
  message: NonNullable<WAMessage["message"]>,
  source: string,
  timestamp: string,
  opts: WhatsAppPluginOptions,
  rawMsg: BaileysMessage,
  mediaSource: MediaHostSource | null = null,
): Promise<ChannelInboundEvent | null> {
  const log = opts.log;
  const mediaDir = opts.paths.inboundMedia;
  const stickerDir = opts.paths.stickers;
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
      const buffer = await downloadFromBaileys(message.imageMessage, rawMsg, "image", mediaSource);
      const media = await downloadMedia(buffer, message.imageMessage.mimetype ?? "image/jpeg", "image", mediaDir);
      mediaArray.push(media);

      // Always build a candidate image block for vision-capable sessions.
      // The daemon decides per session (the active model may have been
      // switched via /model) whether to inline it or fall back to the
      // image tool — the plugin cannot know the session's model here.
      if (opts.model) {
        const { createImageBlock } = await import("./media.js");
        const block = await createImageBlock(media.filePath, media.mimeType);
        if (block) {
          imageBlocks = [block];
        }
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
      const buffer = await downloadFromBaileys(message.videoMessage, rawMsg, "video", mediaSource);
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
      const buffer = await downloadFromBaileys(message.audioMessage, rawMsg, "audio", mediaSource);
      const mediaType = ptt ? "voice" : "audio";
      const media = await downloadMedia(buffer, message.audioMessage.mimetype ?? "audio/ogg", mediaType as InboundMedia["type"], mediaDir);

      if (ptt) {
        // Voice note → transcribe
        const result = await transcribeVoice(media.filePath);
        if (result.ok) {
          // Transkript als Text liefern, Media NICHT zu mediaArray hinzufügen
          // (Agent bekommt den Text, nicht die Datei-Annotation)
          text = `[Voice-Nachricht] ${result.text}`;
          isVoiceTranscript = true;
        } else {
          // Transkription fehlgeschlagen → warn-Log + Annotation im User-Turn,
          // damit der Agent den Grund kennt und dem Nutzer Bescheid sagen kann.
          // (inbound.ts appended annotations an den Turn-Text)
          log(`Voice transcription failed (${result.reason})${result.detail ? `: ${result.detail}` : ""}`, "warn");
          text = "[Voice-Nachricht]";
          annotations.push(voiceErrorAnnotation(result.reason, result.detail));
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
      const buffer = await downloadFromBaileys(message.documentMessage, rawMsg, "document", mediaSource);
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
      const buffer = await downloadFromBaileys(message.stickerMessage, rawMsg, "sticker", mediaSource);
      const media = await downloadMedia(buffer, message.stickerMessage.mimetype ?? "image/webp", "sticker", mediaDir);
      mediaArray.push(media);
      log(`Sticker received from ${source}: ${media.filePath}`, "info");

      // Sticker matching against the local library. Baileys provides the
      // content hash (fileSha256) on the sticker payload — prefer it; fall
      // back to hashing the downloaded bytes.
      const sha256 = message.stickerMessage.fileSha256
        ? Buffer.from(message.stickerMessage.fileSha256).toString("hex")
        : sha256Hex(buffer);

      const { matchOrStoreSticker } = await import("../stickers/library.js");
      const result = await matchOrStoreSticker(stickerDir, sha256, buffer);
      if (result.kind === "match") {
        annotations.push(`[Sticker: ${result.record.name} — ${result.record.beschreibung}]`);
        log(`Sticker matched: ${result.record.name} (${sha256})`, "info");
      } else {
        annotations.push(
          `[Sticker empfangen: unbekannt, gespeichert unter ${result.savedPath}, sha256 ${result.sha256}]`,
        );
        log(`Sticker unknown, saved to ${result.savedPath}`, "info");
      }

      // Return event with media but no text — test mode echoes, normal mode
      // forwards the annotation to the agent turn.
      return {
        channel: "whatsapp",
        source,
        text: "",
        timestamp,
        media: mediaArray,
        imageBlocks: [],
        annotations: annotations.length > 0 ? annotations : undefined,
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
    const { annotations: mediaAnnotations } = await processMediaForTurn(mediaArray, false);
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
 * Downloads media content from a Baileys message component, using the
 * socket's media_conn host (region-optimized) with fallback hosts and
 * bounded retry for transient network failures.
 * @param mediaType - "image" | "video" | "audio" | "sticker" | "document"
 */
async function downloadFromBaileys(
  proto: DownloadableMessage | Record<string, unknown>,
  _rawMsg: BaileysMessage,
  mediaType: "image" | "video" | "audio" | "sticker" | "document",
  mediaSource: MediaHostSource | null,
): Promise<Buffer> {
  return downloadMediaContent(proto as DownloadableMessage, mediaType, mediaSource ?? undefined);
}

/**
 * Builds a machine-readable annotation describing why a voice note could not
 * be transcribed. The annotation is part of the user turn so the model can
 * inform the user naturally.
 */
function voiceErrorAnnotation(reason: VoiceErrorReason, detail?: string): string {
  switch (reason) {
    case "missing-api-key":
      return "Voice note could not be transcribed: missing ASSEMBLYAI_API_KEY — set it in ~/harness/.env and /restart.";
    case "upload-failed": {
      if (detail === "401" || detail === "402" || detail === "429") {
        return `Voice note could not be transcribed: AssemblyAI rejected the upload (HTTP ${detail}) — check your ASSEMBLYAI_API_KEY and quota in ~/harness/.env, then /restart.`;
      }
      return `Voice note could not be transcribed: audio upload to AssemblyAI failed${detail ? ` (HTTP ${detail})` : ""}.`;
    }
    case "submit-failed": {
      if (detail === "401" || detail === "402" || detail === "429") {
        return `Voice note could not be transcribed: AssemblyAI rejected the request (HTTP ${detail}) — check your ASSEMBLYAI_API_KEY and quota in ~/harness/.env, then /restart.`;
      }
      return `Voice note could not be transcribed: transcription request to AssemblyAI failed${detail ? ` (HTTP ${detail})` : ""}.`;
    }
    case "transcription-error":
      return `Voice note could not be transcribed: AssemblyAI reported an error${detail ? `: ${detail}` : ""}.`;
    case "timeout":
      return "Voice note could not be transcribed: transcription timed out.";
    case "read-error":
      return `Voice note could not be transcribed: the audio file could not be read${detail ? ` (${detail})` : ""}.`;
  }
}
