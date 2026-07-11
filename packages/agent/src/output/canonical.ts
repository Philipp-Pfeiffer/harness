/**
 * Canonical Message-IR and pipeline orchestrator.
 *
 * Agent output = canonical Markdown
 *   → remark-parse + remark-gfm → MDAST
 *   → capability-matrix maps (channel, block-type) → render strategy
 *   → channel-text + attachments
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, Content } from 'mdast';

import type { Channel } from './capabilities.js';
import { getCapabilities } from './capabilities.js';
import type { ChannelCapabilities } from './capabilities.js';
import { renderTable } from './renderers/table.js';
import { renderCodeBlock } from './renderers/code.js';
import { splitByLength } from './renderers/length.js';

// ─── IR Types ───

/** An attachment carried alongside message text. */
export interface Attachment {
  readonly type: 'image';
  readonly mimeType: string;
  readonly data: Buffer;
  readonly filename: string;
}

/** A single rendered message destined for a channel. */
export interface RenderedMessage {
  readonly text: string;
  readonly attachments: Attachment[];
}

/** Fallback tier used for table rendering. */
export type TableTier = 'native' | 'monospace' | 'image' | 'linearize';

/** Log entry tracking rendering decisions per block. */
export interface TierLog {
  readonly blockIndex: number;
  readonly blockType: string;
  readonly tier: TableTier;
  readonly reason?: string;
}

/** Result of rendering markdown to channel messages. */
export interface RenderResult {
  readonly channel: Channel;
  readonly messages: RenderedMessage[];
  readonly tierLog: TierLog[];
}

/** Internal: a single block rendered, before length splitting. */
export interface RenderedBlock {
  readonly text: string;
  readonly attachment?: Attachment;
  readonly blockType: string;
  readonly tier?: TableTier;
  readonly reason?: string;
}

// ─── Pipeline ───

export interface RenderOptions {
  /** Path to a .ttf font file for satori table-image rendering. */
  readonly fontPath?: string;
}

/** Default font path for satori (Noto Sans on most Linux systems). */
const DEFAULT_FONT_PATH = '/usr/share/fonts/noto/NotoSans-Regular.ttf';

/**
 * Render canonical markdown to channel-specific messages.
 *
 * Never throws — malformed markdown falls back to plaintext passthrough.
 */
export async function renderToChannel(
  markdown: string,
  channel: Channel,
  options?: RenderOptions,
): Promise<RenderResult> {
  const caps = getCapabilities(channel);
  const fontPath = options?.fontPath ?? DEFAULT_FONT_PATH;

  let root: Root;
  try {
    root = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  } catch {
    // Parse failure → plaintext passthrough, split by length
    return {
      channel,
      messages: splitByLength(
        [{ text: markdown, blockType: 'plaintext' }],
        caps.maxLength,
      ),
      tierLog: [],
    };
  }

  const blocks: RenderedBlock[] = [];
  const tierLog: TierLog[] = [];

  for (let i = 0; i < root.children.length; i++) {
    const node = root.children[i]!;
    try {
      const block = await renderBlock(node, markdown, caps, fontPath, i, tierLog);
      blocks.push(block);
    } catch (err) {
      // Per-block failure → use raw markdown for that block
      const raw = extractRaw(markdown, node);
      blocks.push({
        text: raw,
        blockType: node.type,
        reason: `render error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const messages = splitByLength(blocks, caps.maxLength);
  return { channel, messages, tierLog };
}

/**
 * Render a single MDAST block node to a RenderedBlock.
 * Dispatches to the appropriate renderer based on node type.
 */
async function renderBlock(
  node: Content,
  markdown: string,
  caps: ChannelCapabilities,
  fontPath: string,
  blockIndex: number,
  tierLog: TierLog[],
): Promise<RenderedBlock> {
  switch (node.type) {
    case 'table':
      return renderTable(node, caps, fontPath, blockIndex, tierLog);

    case 'code':
      return {
        text: renderCodeBlock(node, caps),
        blockType: 'code',
      };

    default:
      // All other block types: pass through raw markdown
      return {
        text: extractRaw(markdown, node),
        blockType: node.type,
      };
  }
}

/**
 * Extract the original markdown substring for a node using its position.
 * Falls back to empty string if position is unavailable.
 */
export function extractRaw(markdown: string, node: Content): string {
  const pos = node.position;
  if (!pos) return '';
  const start = pos.start.offset;
  const end = pos.end.offset;
  if (start == null || end == null) return '';
  return markdown.slice(start, end);
}
