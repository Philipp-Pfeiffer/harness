/**
 * WhatsApp Gateway Limits and Timing Constants.
 *
 * Centralized in one file so all WhatsApp modules share the same values.
 */

/** Maximum media download size: 100 MB. */
export const MAX_MEDIA_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Maximum size for an image that is inlined into the turn context as a
 * content block. Mirrors the image tool's cap (10 MB). Larger images fall
 * back to file-annotation + image tool.
 */
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum largest-side dimension for inlined images. WhatsApp photos are
 * typically 1280px or 1600px — 2048px keeps token cost bounded while
 * preserving readable detail.
 */
export const MAX_INLINE_IMAGE_DIMENSION = 2048;

/** Delay between outbound message chunks (ms). Anti-ban mitigation. */
export const OUTBOUND_CHUNK_DELAY_MS = 500;

/** Debounce window for inbound message bursts (ms). */
export const INBOUND_DEBOUNCE_MS = 1_000;

/** Inactivity threshold for session compaction (8 hours in ms). */
export const SESSION_INACTIVITY_THRESHOLD_MS = 8 * 60 * 60 * 1_000;

/**
 * Cooldown after a session rotation during which the 8h-inactivity check is
 * skipped. Protects a freshly rotated session from being killed by a second
 * rotation triggered by a stale lastActivityMs (the real-world incident:
 * the first turn after rotation ran longer than the gap to the next message).
 */
export const ROTATION_GUARD_MS = 60_000;

/**
 * Interval for refreshing the WhatsApp composing indicator while a turn is
 * running. WhatsApp's composing state expires after ~20-30s, so it must be
 * re-sent well within that window.
 */
export const PRESENCE_COMPOSING_REFRESH_MS = 15_000;

/** Reconnect backoff base (ms). */
export const RECONNECT_BACKOFF_BASE_MS = 1_000;

/** Reconnect backoff maximum (ms). */
export const RECONNECT_BACKOFF_MAX_MS = 30_000;

/** Number of random characters in media filenames. */
export const MEDIA_FILENAME_RANDOM_CHARS = 4;
