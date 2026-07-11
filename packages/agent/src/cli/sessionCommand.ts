import {
  type SessionListDetail,
  SESSION_LOAD_WARN_THRESHOLD,
} from "../core/session.js";

export type SessionCommand =
  | { type: "list" }
  | { type: "resume"; sessionId: string; force: boolean };

/**
 * Returns true for `/session` or `/session ...` inputs.
 */
export function isSessionCommand(input: string): boolean {
  const trimmed = input.trim();
  return trimmed === "/session" || trimmed.startsWith("/session ");
}

/**
 * Parses a `/session` command into a structured action.
 * Returns null for malformed input.
 */
export function parseSessionCommand(input: string): SessionCommand | null {
  const trimmed = input.trim();
  if (!isSessionCommand(trimmed)) return null;

  const rest = trimmed.slice("/session".length).trim();
  if (!rest) return { type: "list" };

  const parts = rest.split(/\s+/);
  const sessionId = parts[0];
  if (!sessionId) return null;

  const force = parts.includes("--force");
  return { type: "resume", sessionId, force };
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Renders the `/session` list output.
 */
export function formatSessionList(sessions: SessionListDetail[]): string {
  if (sessions.length === 0) return "No sessions found.";

  const lines = sessions.map((s) => {
    const date = s.created.slice(0, 10);
    const total = formatTokenCount(s.tokenTotals.totalTokens);
    return `${s.sessionId} · ${date} · ${s.model} · ${s.turnCount} turns · ${total} tokens`;
  });

  return ["Sessions:", ...lines.map((l) => `  ${l}`)].join("\n");
}

/**
 * Builds the warning message shown when a session exceeds the load threshold.
 */
export function formatSessionLoadWarning(
  sessionId: string,
  tokenEstimate: number
): string {
  return (
    `Resuming session ${sessionId} will load ~${formatTokenCount(
      tokenEstimate
    )} tokens ` +
    `(threshold: ${formatTokenCount(SESSION_LOAD_WARN_THRESHOLD)}).\n` +
    `Type "y" and press Enter to proceed, or anything else to cancel.`
  );
}
