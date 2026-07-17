import { resolve } from "node:path";

/**
 * Session-scoped read state for the read-before-edit guard.
 *
 * Read marks are keyed by sessionId so parallel sessions (e.g. daemon
 * sessions sharing one agent process) never leak state into each other:
 * a file read by session A is NOT considered read by session B.
 *
 * There is intentionally no global/default bucket — every call requires an
 * explicit session scope. Callers without a session scope must treat every
 * file as unread (strict deny).
 */
const readPathsBySession = new Map<string, Set<string>>();

export function markRead(sessionId: string, absolutePath: string): void {
  const normalized = resolve(absolutePath);
  let paths = readPathsBySession.get(sessionId);
  if (!paths) {
    paths = new Set<string>();
    readPathsBySession.set(sessionId, paths);
  }
  paths.add(normalized);
}

export function wasRead(sessionId: string, absolutePath: string): boolean {
  const normalized = resolve(absolutePath);
  return readPathsBySession.get(sessionId)?.has(normalized) ?? false;
}
