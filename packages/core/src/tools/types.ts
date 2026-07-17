import type { Static, TSchema } from "@mariozechner/pi-ai";

/**
 * Per-call execution context passed by the agent loop.
 *
 * `sessionId` scopes per-session tool state (e.g. the read-before-edit
 * guard in `file_state.ts`). The agent always provides a scope: either the
 * run's sessionId or a per-agent-instance default. Direct tool callers that
 * omit the context get strict behavior (every file counts as unread).
 */
export interface ToolCallContext {
  sessionId?: string;
}

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  execute(args: Static<TParameters>, context?: ToolCallContext): Promise<string> | string;
  /**
   * Optional: returns a string key that determines which tool calls
   * must run serially with respect to each other. Tool calls with the
   * same conflictKey execute sequentially in original order. Returns
   * `null` or `undefined` → no conflict, runs in parallel with all.
   */
  conflictKey?(args: Static<TParameters>): string | null | undefined;
}
