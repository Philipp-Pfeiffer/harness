/**
 * Library entry point for @harness/agent.
 *
 * Re-exports the stable session read API for external consumers
 * (e.g. the distillation pipeline). CLI/TUI entry remains `index.tsx`.
 */
export {
  createSession,
  createSessionId,
  createSubAgentSession,
  endSession,
  suspendSession,
  recordTurn,
  readSession,
  loadSession,
  listSessions,
  listSessionsWithDetails,
  countTurnsInTranscript,
  turnsToMessages,
  estimateContextTokens,
  calculateTurnCost,
  extractToolData,
  markActiveSessionsIdle,
  migrateLegacySessionFiles,
  SESSION_LOAD_WARN_THRESHOLD,
  SESSION_LOAD_SILENT_MAX,
  type Session,
  type SessionStatus,
  type SessionIndexEntry,
  type SessionTurn,
  type SessionTurnToolCall,
  type SessionTurnToolResult,
  type SessionTurnTokens,
  type SessionTurnCost,
  type SessionTurnTiming,
  type SessionTokenTotals,
  type SessionEndMarker,
  type ListSessionsRange,
  type CreateSessionOptions,
  type ModelCost,
  type SessionListDetail,
} from "./core/session.js";
