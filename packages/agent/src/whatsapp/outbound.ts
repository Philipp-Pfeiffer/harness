/**
 * WhatsApp Outbound Message Sender.
 *
 * Renders agent output through the channel pipeline, then sends
 * each rendered message sequentially with a delay between chunks
 * (anti-ban mitigation).
 */

import { renderToChannel, type RenderedMessage } from "../output/index.js";
import { OUTBOUND_CHUNK_DELAY_MS } from "./limits.js";

type LogFn = (msg: string, level?: "info" | "warn" | "error") => void;

/**
 * Renders markdown to WhatsApp channel messages and sends them sequentially.
 *
 * @param target JID to send to.
 * @param markdown Agent output markdown.
 * @param sendMessageFn Function that sends a single text message to a JID.
 * @param log Optional logger.
 */
export async function sendAgentResponse(
  target: string,
  markdown: string,
  sendMessageFn: (jid: string, text: string) => Promise<void>,
  log?: LogFn,
): Promise<void> {
  const result = await renderToChannel(markdown, "whatsapp");

  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i]!;
    await sendMessageFn(target, msg.text);

    // Delay between chunks (not after the last one)
    if (i < result.messages.length - 1) {
      await sleep(OUTBOUND_CHUNK_DELAY_MS);
    }
  }

  log?.(`Sent ${result.messages.length} message(s) to ${target}`, "info");
}

/**
 * Sends pre-rendered messages sequentially with delay between chunks.
 * Used when messages are already rendered (e.g. test-mode echo).
 */
export async function sendRenderedMessages(
  target: string,
  messages: RenderedMessage[],
  sendMessageFn: (jid: string, text: string) => Promise<void>,
  log?: LogFn,
): Promise<void> {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    await sendMessageFn(target, msg.text);

    if (i < messages.length - 1) {
      await sleep(OUTBOUND_CHUNK_DELAY_MS);
    }
  }

  log?.(`Sent ${messages.length} message(s) to ${target}`, "info");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
