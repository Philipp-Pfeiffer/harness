/**
 * WhatsApp Outbound Message Sender.
 *
 * Renders agent output through the channel pipeline, then sends
 * each rendered message sequentially with a delay between chunks
 * (anti-ban mitigation). Attachments (PNG renderings of tables/code)
 * are sent as image messages at the correct position in the sequence.
 */

import { renderToChannel, type RenderedMessage } from "../output/index.js";
import { supportsMimeType } from "../output/capabilities.js";
import { OUTBOUND_CHUNK_DELAY_MS } from "./limits.js";
import type { ChannelFile, ChannelSendPayload } from "../daemon/types.js";

type LogFn = (msg: string, level?: "info" | "warn" | "error") => void;

/** Send function interface — accepts structured payloads. */
export interface SendPayloadFn {
  (jid: string, payload: ChannelSendPayload): Promise<void>;
}

/**
 * Renders markdown to WhatsApp channel messages and sends them sequentially.
 * Attachments (PNG renderings) are sent as image messages.
 *
 * Send errors per attachment → Text-Fallback in the message
 * („[Tabelle konnte nicht gesendet werden]"), niemals stiller Verlust.
 *
 * @param target JID to send to.
 * @param markdown Agent output markdown.
 * @param sendPayloadFn Function that sends a structured payload to a JID.
 * @param log Optional logger.
 */
export async function sendAgentResponse(
  target: string,
  markdown: string,
  sendPayloadFn: SendPayloadFn,
  log?: LogFn,
): Promise<void> {
  const result = await renderToChannel(markdown, "whatsapp");

  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i]!;
    const isLast = i === result.messages.length - 1;

    // Send text first (if non-empty)
    if (msg.text.trim()) {
      await sendPayloadFn(target, { text: msg.text });
      if (!isLast || msg.attachments.length > 0) {
        await sleep(OUTBOUND_CHUNK_DELAY_MS);
      }
    }

    // Send attachments (PNG renderings)
    for (let j = 0; j < msg.attachments.length; j++) {
      const att = msg.attachments[j]!;
      try {
        const file: ChannelFile = {
          buffer: att.data,
          mimeType: att.mimeType,
          caption: att.filename,
        };
        await sendPayloadFn(target, { files: [file] });
      } catch (err) {
        // Text-Fallback — niemals stiller Verlust
        const fallback = `[${att.filename ?? "Attachment"} konnte nicht gesendet werden]`;
        await sendPayloadFn(target, { text: fallback });
        log?.(`Attachment send failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }

      if (!isLast || j < msg.attachments.length - 1) {
        await sleep(OUTBOUND_CHUNK_DELAY_MS);
      }
    }
  }

  log?.(`Sent ${result.messages.length} message(s) to ${target}`, "info");
}

/**
 * Sends pre-rendered messages sequentially with delay between chunks.
 * Attachments are sent as image messages.
 * Used when messages are already rendered (e.g. direct channel routing).
 */
export async function sendRenderedMessages(
  target: string,
  messages: RenderedMessage[],
  sendPayloadFn: SendPayloadFn,
  log?: LogFn,
): Promise<void> {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const isLast = i === messages.length - 1;

    if (msg.text.trim()) {
      await sendPayloadFn(target, { text: msg.text });
      if (!isLast || msg.attachments.length > 0) {
        await sleep(OUTBOUND_CHUNK_DELAY_MS);
      }
    }

    for (let j = 0; j < msg.attachments.length; j++) {
      const att = msg.attachments[j]!;
      try {
        await sendPayloadFn(target, {
          files: [{ buffer: att.data, mimeType: att.mimeType, caption: att.filename }],
        });
      } catch (err) {
        await sendPayloadFn(target, { text: `[${att.filename ?? "Attachment"} konnte nicht gesendet werden]` });
        log?.(`Attachment send failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }

      if (!isLast || j < msg.attachments.length - 1) {
        await sleep(OUTBOUND_CHUNK_DELAY_MS);
      }
    }
  }

  log?.(`Sent ${messages.length} message(s) to ${target}`, "info");
}

/**
 * Checks whether the channel supports sending a file with the given MIME type.
 */
export function isFileSupported(channel: string, mimeType: string): boolean {
  return supportsMimeType(channel as never, mimeType);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
