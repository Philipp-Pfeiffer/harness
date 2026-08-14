/**
 * Progressive speech chunking for voice turns.
 *
 * The agent streams the final answer token by token. Instead of waiting for
 * the complete response, we flush chunks at sentence boundaries (`.`, `!`,
 * `?`, newline) or once a minimum chunk size is reached, so the callee
 * hears the first sentence while the model is still generating.
 *
 * Thinking-leak protection: reasoning content may arrive as `token` deltas
 * that are later reclassified via `token_revoke`. A short pending window
 * (characters) is held back from flushing so a revoke can still retract
 * text that has not been spoken yet.
 */

/** Minimum accumulated text (characters) before a flush without a boundary. */
const MIN_CHUNK = 80;
/** Characters flushed from the buffer per token event to keep `say` cadence. */
const MAX_FLUSH = 200;
/** Characters held back from flushing to allow `token_revoke` retraction. */
const PENDING_TAIL = 12;

/**
 * Splits a growing text buffer into speakable chunks. Consumes up to a
 * boundary or `MIN_CHUNK` characters per call, keeping `PENDING_TAIL`
 * characters back for `token_revoke` retraction. `flush=true` (turn end)
 * returns the entire remainder so nothing is dropped.
 */
export function takeProgressiveChunk(buffer: string, flush = false): string {
  if (!buffer) return "";

  if (flush) {
    const rest = buffer.trimEnd();
    return rest;
  }

  let length = 0;
  let boundaryAt = -1;
  for (const ch of buffer) {
    length++;
    if (boundaryAt < 0 && (ch === "." || ch === "!" || ch === "?" || ch === "\n")) {
      boundaryAt = length;
    }
    if (boundaryAt >= 0 && length >= MIN_CHUNK) break;
    if (length >= MIN_CHUNK * 2) break;
  }

  // Satzende-Grenze: es wird immer das ERSTE gefundene Satzende genutzt
  // (letzteres wäre nie "alt" genug). Geflusht wird, sobald mindestens
  // PENDING_TAIL Zeichen hinter der Grenze liegen — dann ist das
  // Satzende außerhalb des Revoke-Fensters. Ein frisches Satzende
  // (Trail < PENDING_TAIL) wartet, bis genug Folge-Text da ist, und kann
  // so von token_revoke noch zurückgezogen werden. Ohne Satzgrenze wird
  // erst ab der Mindestgröße geflusht (sonst entstehen Fragmente).
  if (boundaryAt > 0) {
    if (length - boundaryAt < PENDING_TAIL) return "";
    const chunk = buffer.slice(0, boundaryAt);
    return chunk.length <= MAX_FLUSH ? chunk : chunk.slice(0, MAX_FLUSH);
  }
  if (length < MIN_CHUNK) return "";
  const cut = length - PENDING_TAIL;
  const chunk = buffer.slice(0, cut);
  return chunk.length <= MAX_FLUSH ? chunk : chunk.slice(0, MAX_FLUSH);
}
