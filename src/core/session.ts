/**
 * Session management – persistence, identifiers, and lifecycle.
 */

import type { Context } from "./context.js";

export interface Session {
  id: string;
  context: Context;
  createdAt: Date;
  updatedAt: Date;
}

export function createSession(id: string, context: Context): Session {
  const now = new Date();
  return {
    id,
    context,
    createdAt: now,
    updatedAt: now,
  };
}

export function touchSession(session: Session): void {
  session.updatedAt = new Date();
}

// TODO: add load/save adapters (file, sqlite, redis, etc.)
