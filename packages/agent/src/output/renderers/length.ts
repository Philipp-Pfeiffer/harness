/**
 * AST-aware length splitter.
 *
 * Splits rendered blocks into messages respecting the channel's max length.
 * Never cuts mid-block — each block is atomic.
 * Attachment-only blocks (e.g. image-tier tables) flush preceding text and
 * form their own message, preserving source order.
 */

import type { RenderedBlock, RenderedMessage } from '../canonical.js';

/**
 * Split rendered blocks into messages within maxLength.
 *
 * - Each block is atomic — never split mid-block.
 * - A block larger than maxLength becomes its own (oversized) message.
 * - Attachment-only blocks (empty text) flush preceding text into its own
 *   message, then become their own attachment-only message — preserving order.
 * - Text blocks with attachments: the attachment rides with the text message.
 */
export function splitByLength(
  blocks: readonly RenderedBlock[],
  maxLength: number,
): RenderedMessage[] {
  const messages: RenderedMessage[] = [];
  let currentText = '';
  let currentAttachments: RenderedMessage['attachments'] = [];
  let hasContent = false;

  const flush = (): void => {
    if (hasContent) {
      messages.push({
        text: currentText.trimEnd(),
        attachments: currentAttachments,
      });
    }
    currentText = '';
    currentAttachments = [];
    hasContent = false;
  };

  for (const block of blocks) {
    const blockText = block.text;
    const attachment = block.attachment;

    // Attachment-only block (e.g. image tier table)
    // → flush preceding text, then emit as its own attachment-only message
    if (attachment && !blockText) {
      flush();
      messages.push({ text: '', attachments: [attachment] });
      continue;
    }

    // Text block (with or without attachment)
    if (!hasContent) {
      currentText = blockText;
      currentAttachments = attachment ? [attachment] : [];
      hasContent = true;
      continue;
    }

    // Would it fit?
    const combined = currentText + '\n\n' + blockText;
    if (combined.length <= maxLength) {
      currentText = combined;
      if (attachment) {
        currentAttachments = [...currentAttachments, attachment];
      }
    } else {
      // Doesn't fit — flush current, start new
      flush();
      currentText = blockText;
      currentAttachments = attachment ? [attachment] : [];
      hasContent = true;
    }
  }

  flush();
  return messages;
}
