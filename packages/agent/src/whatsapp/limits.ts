/**
 * WhatsApp Gateway Limits and Timing Constants.
 *
 * Centralized in one file so all WhatsApp modules share the same values.
 */

/** Maximum media download size: 100 MB. */
export const MAX_MEDIA_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** Delay between outbound message chunks (ms). Anti-ban mitigation. */
export const OUTBOUND_CHUNK_DELAY_MS = 500;

/** Debounce window for inbound message bursts (ms). */
export const INBOUND_DEBOUNCE_MS = 1_000;

/** Window after turn start where new messages trigger abort-and-restart (ms). */
export const ABORT_RESTART_WINDOW_MS = 5_000;

/** Maximum restarts per turn before switching to steer-only. */
export const MAX_RESTARTS_PER_TURN = 2;

/** Inactivity threshold for session compaction (8 hours in ms). */
export const SESSION_INACTIVITY_THRESHOLD_MS = 8 * 60 * 60 * 1_000;

/** Reconnect backoff base (ms). */
export const RECONNECT_BACKOFF_BASE_MS = 1_000;

/** Reconnect backoff maximum (ms). */
export const RECONNECT_BACKOFF_MAX_MS = 30_000;

/** Number of random characters in media filenames. */
export const MEDIA_FILENAME_RANDOM_CHARS = 4;
