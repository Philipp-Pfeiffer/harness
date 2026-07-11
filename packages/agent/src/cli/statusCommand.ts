import {
  buildStatusSummary,
  formatStatusSummary,
  type StatusContext,
} from "../core/statusSummary.js";

/**
 * Returns true if the input starts with `/status` (followed by end-of-string
 * or whitespace). This is the TUI slash-command check — no LLM call is made.
 */
export function isStatusCommand(input: string): boolean {
  const trimmed = input.trim();
  return trimmed === "/status" || trimmed.startsWith("/status ");
}

/**
 * Handles the `/status` slash command by building and formatting a status
 * summary from runtime context. Returns the formatted string to display
 * in the chat output area.
 *
 * No LLM call, no tool calls, no agent run.
 */
export async function handleStatusCommand(
  _input: string,
  context: StatusContext,
): Promise<string> {
  const summary = await buildStatusSummary(context);
  return formatStatusSummary(summary);
}
