/**
 * Barrel exports for the output pipeline.
 */

export type {
  Attachment,
  RenderedMessage,
  TableTier,
  TierLog,
  RenderResult,
  RenderedBlock,
  RenderOptions,
} from './canonical.js';

export { renderToChannel, extractRaw } from './canonical.js';

export type {
  Channel,
  ChannelCapabilities,
  MarkdownSupport,
} from './capabilities.js';

export { getCapabilities, getSupportedChannels } from './capabilities.js';
