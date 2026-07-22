/**
 * Channel Capability Matrix.
 *
 * Maps (channel, block-type) → render strategy.
 * Extensible for future channels (signal, mail).
 */

/** Markdown support level the channel renders natively. */
export type MarkdownSupport = 'full' | 'partial' | 'none';

/**
 * Capabilities a channel exposes to the output pipeline.
 * Every field has a sane default so adding a new channel is trivial.
 */
export interface ChannelCapabilities {
  readonly channel: Channel;
  /** Max text length per message (chars). */
  readonly maxLength: number;
  /** How much markdown the channel renders on its own. */
  readonly markdown: MarkdownSupport;
  /** Whether the channel renders GFM tables natively. */
  readonly supportsNativeTables: boolean;
  /** Whether the channel renders code fences natively. */
  readonly supportsCodeFences: boolean;
  /** Max monospace code-block width (chars) before a table escalates to image-tier. */
  readonly maxMonospaceWidth: number;
  /** Max table columns before monospace becomes unreadable. */
  readonly maxTableColumns: number;
  /** Raster scale factor for table-image PNGs (higher = sharper on mobile). */
  readonly imageScale: number;
  /** Supported file MIME type prefixes for outbound attachments. */
  readonly supportedFilePrefixes: readonly string[];
  /** Whether the channel supports stickers. */
  readonly supportsSticker: boolean;
  /** Max outbound file size in bytes (0 = unlimited). */
  readonly maxFileSize: number;
}

/** Re-exported from canonical to avoid circular deps. */
export type Channel = 'whatsapp' | 'discord' | 'signal' | 'mail';

const WHATSAPP: ChannelCapabilities = {
  channel: 'whatsapp',
  maxLength: 4096,
  markdown: 'partial',
  supportsNativeTables: false,
  supportsCodeFences: true,
  maxMonospaceWidth: 60,
  maxTableColumns: 4,
  imageScale: 3,
  supportedFilePrefixes: ['image/', 'audio/', 'video/', 'application/pdf', 'application/zip', 'application/octet-stream', 'text/'],
  supportsSticker: true,
  maxFileSize: 100 * 1024 * 1024,
};

const DISCORD: ChannelCapabilities = {
  channel: 'discord',
  maxLength: 2000,
  markdown: 'partial',
  supportsNativeTables: false,
  supportsCodeFences: true,
  maxMonospaceWidth: 80,
  maxTableColumns: 5,
  imageScale: 3,
  supportedFilePrefixes: ['image/', 'audio/', 'video/', 'application/', 'text/'],
  supportsSticker: false,
  maxFileSize: 25 * 1024 * 1024,
};

const SIGNAL: ChannelCapabilities = {
  channel: 'signal',
  maxLength: 4096,
  markdown: 'partial',
  supportsNativeTables: false,
  supportsCodeFences: true,
  maxMonospaceWidth: 60,
  maxTableColumns: 4,
  imageScale: 3,
  supportedFilePrefixes: ['image/', 'audio/', 'video/', 'application/pdf'],
  supportsSticker: false,
  maxFileSize: 100 * 1024 * 1024,
};

const MAIL: ChannelCapabilities = {
  channel: 'mail',
  maxLength: 100_000,
  markdown: 'full',
  supportsNativeTables: true,
  supportsCodeFences: true,
  maxMonospaceWidth: 120,
  maxTableColumns: 8,
  imageScale: 1,
  supportedFilePrefixes: ['image/', 'audio/', 'video/', 'application/', 'text/'],
  supportsSticker: false,
  maxFileSize: 0,
};

const MATRIX: Readonly<Record<Channel, ChannelCapabilities>> = {
  whatsapp: WHATSAPP,
  discord: DISCORD,
  signal: SIGNAL,
  mail: MAIL,
};

export function getCapabilities(channel: Channel): ChannelCapabilities {
  return MATRIX[channel] ?? WHATSAPP;
}

export function getSupportedChannels(): Channel[] {
  return Object.keys(MATRIX) as Channel[];
}

/** Checks whether the channel supports a given MIME type. */
export function supportsMimeType(channel: Channel, mimeType: string): boolean {
  const caps = getCapabilities(channel);
  return caps.supportedFilePrefixes.some((prefix) => mimeType.startsWith(prefix));
}
