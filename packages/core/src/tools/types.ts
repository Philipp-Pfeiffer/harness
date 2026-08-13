import type { Static, TSchema } from "@mariozechner/pi-ai";

/**
 * Unified result type returned by every tool's `execute()`.
 *
 * - `content` is the human/LLM-visible text (stdout, file contents, error message, …).
 * - `isError` tells the agent loop to flag the tool result as an error for the LLM.
 *
 * Tools should return `ok(content)` for success and `err(content)` for expected
 * failures (file not found, validation, blocked path, …). Unexpected errors
 * may be thrown — the agent loop catches them and treats them as errors.
 */
export interface ToolResult {
  content: string;
  isError: boolean;
}

/** Success helper: `return ok("file contents…")` */
export function ok(content: string): ToolResult {
  return { content, isError: false };
}

/** Error helper: `return err("File not found: /path")` */
export function err(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * Per-call execution context passed by the agent loop.
 *
 * `sessionId` scopes per-session tool state (e.g. the read-before-edit
 * guard in `file_state.ts`). The agent always provides a scope: either the
 * run's sessionId or a per-agent-instance default. Direct tool callers that
 * omit the context get strict behavior (every file counts as unread).
 *
 * `logger` is an optional diagnostic logger. When present, tools should use
 * it instead of `console.warn` for non-critical warnings.
 */
export interface ToolCallContext {
  sessionId?: string;
  /**
   * Optional working directory for the profile's tool calls. When set,
   * relative paths in exec/readFile/write/edit resolve against it instead
   * of the process cwd. Supports ~ (expanded against the home directory).
   */
  cwd?: string;
  logger?: (msg: string, level?: "warn" | "debug") => void;
  /**
   * Optional channel file sender. When present, enables the `send_file` tool
   * to send files to the active channel chat. When absent (e.g. TUI sessions),
   * `send_file` returns an error.
   */
  channelFileSender?: (sessionId: string, file: { path: string; mimeType: string; caption?: string }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Optional channel sticker sender. When present, enables the `send_sticker`
   * tool to send a sticker from the local library to the active channel chat.
   * The daemon injects this together with `stickerLibraryDir` for sessions
   * backed by a sticker-capable channel; otherwise `send_sticker` returns an
   * error.
   */
  channelStickerSender?: (sessionId: string, sticker: { name: string; filePath: string }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Optional sticker library directory ($HARNESS_STATE/stickers/). Passed
   * with `channelStickerSender` so the send_sticker tool can resolve sticker
   * names against index.json.
   */
  stickerLibraryDir?: string;
  /**
   * Optional deferred-restart capability for the `request_restart` tool.
   * Injected by the daemon for running sessions; the tool calls it with a
   * reason and the daemon schedules the restart for after the turn. When
   * absent (e.g. TUI in-process without a daemon), `request_restart`
   * returns an error.
   */
  requestRestart?: (reason: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * When true, this turn is a post-restart follow-up turn. The
   * `request_restart` tool refuses to schedule another restart while this
   * flag is set — otherwise an agent-initiated restart could loop.
   */
  postRestartFollowUp?: boolean;
  /**
   * Optional voice-call starter capability for the `call_user` tool.
   * Injected by the daemon when the voice channel is active; the tool calls
   * it with the target number + briefing and the daemon enforces the
   * registry gate (fail-closed) + rate limit before placing the call.
   * When absent (no voice channel active), `call_user` returns an error.
   */
  voiceCallStarter?: (sessionId: string, call: { number: string; briefing: string }) => Promise<{ ok: boolean; error?: string; callId?: string }>;
  /**
   * Optional report-to-main-session capability for the `report_to_main_session`
   * tool. Injected by the daemon ONLY for voice sessions (origin "voice"):
   * it delivers a system event into the owner's main WhatsApp session via
   * the system event bus. When absent (any non-voice session),
   * `report_to_main_session` returns an error.
   */
  voiceReportToMainSession?: (text: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Optional status callback for long-running tools (e.g. browser sub-agent).
   * When present, tools may emit progress updates that reach the TUI via IPC.
   */
  onStatus?: (status: string) => void;
  /** ID of the current tool call in the main agent loop (for trace linking). */
  toolCallId?: string;
  /**
   * User abort signal from the agent loop. Long-running tools should
   * cancel in-flight work (kill subprocesses, disconnect browsers, etc.)
   * when this signal fires.
   */
  signal?: AbortSignal;
}

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  execute(args: Static<TParameters>, context?: ToolCallContext): Promise<ToolResult> | ToolResult;
  /**
   * Optional: returns a string key that determines which tool calls
   * must run serially with respect to each other. Tool calls with the
   * same conflictKey execute sequentially in original order. Returns
   * `null` or `undefined` → no conflict, runs in parallel with all.
   */
  conflictKey?(args: Static<TParameters>): string | null | undefined;
}
