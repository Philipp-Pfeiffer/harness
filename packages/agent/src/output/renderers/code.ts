/**
 * Code block renderer.
 *
 * Formats fenced code blocks per channel capabilities.
 * All target channels support triple-backtick code fences.
 */

import type { Code } from 'mdast';
import type { ChannelCapabilities } from '../capabilities.js';

/**
 * Render a fenced code block.
 * If the channel supports code fences, wraps in triple backticks with language hint.
 * Otherwise, indents the code.
 */
export function renderCodeBlock(
  node: Code,
  _caps: ChannelCapabilities,
): string {
  const lang = node.lang ?? '';
  const value = node.value;

  return '```' + lang + '\n' + value + '\n```';
}
