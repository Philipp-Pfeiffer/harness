import type { SessionOrigin } from "../core/session.js";

/**
 * Channel-specific system-prompt addendum.
 *
 * A pure function of the session origin: "whatsapp" returns a static
 * markdown block, every other origin returns null (no addendum). The text
 * is constant per session because the origin is fixed at session creation
 * and persisted — this keeps the effective system prompt byte-identical
 * across turns and daemon restarts (required for prompt caching).
 */
export function channelAddendum(origin: SessionOrigin): string | undefined {
  if (origin !== "whatsapp") return undefined;
  return WHATSAPP_ADDENDUM;
}

const WHATSAPP_ADDENDUM = `## WhatsApp formatting

This conversation happens over WhatsApp. Format all replies for WhatsApp.

These formatting rules override any general markdown conventions from the base prompt:
- Bold with *single asterisks* (NOT **double** asterisks), italic with _underscores_, strikethrough with ~tildes~, \`inline code\` and \`\`\`code fences\`\`\` all work natively in WhatsApp.
- Do NOT use markdown headings (# renders as raw text), markdown link syntax ([text](url) renders raw — write URLs plainly), or image markdown (![](...) renders raw).
- Tables are allowed and rendered as images — use them when they genuinely structure data.
- Lists with - or 1. are fine. Keep messages conversational in length; long output is split at paragraph boundaries (~4000 characters).
- To send files or images, use the send_file tool.`;
