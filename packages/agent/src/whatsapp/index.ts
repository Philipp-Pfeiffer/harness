/**
 * WhatsApp Gateway Module — Barrel Exports.
 */

// Client
export { createWhatsAppClient, createMockWhatsAppClient } from "./client.js";
export type { WhatsAppClient, WhatsAppClientOptions, BaileysMessage, ConnectionUpdate, WAMessage, DisconnectReason } from "./client.js";

// Whitelist
export { isWhitelisted, hasWhitelist, extractPhoneNumber, formatJid } from "./whitelist.js";

// Media
export {
  downloadMedia,
  generateMediaFilename,
  getMimeTypeExtension,
  isVisionCapableModel,
  createImageBlock,
  processMediaForTurn,
  formatFileSize,
  MediaTooLargeError,
} from "./media.js";
export type { MediaInfo, MediaMessageType } from "./media.js";

// Voice
export { transcribeVoice } from "./voice.js";

// Outbound
export { sendAgentResponse, sendRenderedMessages } from "./outbound.js";

// Inbound processor
export { WhatsAppInboundProcessor } from "./inbound.js";
export type { InboundProcessorCallbacks, WhatsAppInboundProcessorOptions } from "./inbound.js";

// Plugin
export { createWhatsAppPlugin } from "./plugin.js";
export type { WhatsAppPluginOptions } from "./plugin.js";

// Limits
export * from "./limits.js";
