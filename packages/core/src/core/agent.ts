import { stream } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";
import { resolveModel, getApiKey } from "./resolveModel.js";
import { prompt } from "../prompts.js";
import { shouldCompact, compactSession } from "./compaction.js";
import type { HarnessPaths } from "../config/paths.js";
import { Value } from "typebox/value";
import type {
  Context as PiContext,
  Tool as PiTool,
  ToolCall as PiToolCall,
  ToolResultMessage,
  TextContent,
  Model,
  Api,
  Message,
  AssistantMessage,
} from "@mariozechner/pi-ai";
import type { Tool, ToolCallContext, ToolResult } from "../tools/types.js";
import type { Mailbox } from "./mailbox.js";
import { formatMemoryHint } from "./memoryBackend.js";
import type { MemoryBackend } from "./memoryBackend.js";
import type { MetricsRecorder } from "./metrics.js";
import { traceTokenUsage } from "./tokenTrace.js";
import { ThinkingStreamTransformer } from "./thinkingStream.js";
import {
  DEFAULT_RETRY_POLICY,
  classifyError,
  extractRetryAfter,
  computeBackoffDelay,
  TimeoutController,
  sleepCancellable,
  type RetryPolicy,
  type RetryInfo,
} from "./retryPolicy.js";

interface ValidationErrorLike {
  instancePath: string;
  message: string;
}

function unescapeJsonPointer(key: string): string {
  return key.replace(/~1/g, "/").replace(/~0/g, "~");
}

function getValueAtPath(value: unknown, path: string): unknown {
  if (!path || path === "/") return value;
  const segments = path.split("/").slice(1).map(unescapeJsonPointer);
  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function formatValidationErrorValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    const truncated = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    return `"${truncated}"`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) return String(value);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

function formatToolValidationErrors(
  toolName: string,
  errors: Iterable<ValidationErrorLike>,
  args: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const err of errors) {
    const path = err.instancePath || "/";
    const valueText = formatValidationErrorValue(getValueAtPath(args, err.instancePath));
    parts.push(`${path}: ${err.message}, got ${valueText}`);
  }
  return `Argumente für Tool "${toolName}" ungültig: ${parts.join("; ")}`;
}

export interface ToolCallLog {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
}

export type Logger = (msg: string, level?: "warn" | "debug") => void;



/**
 * Options passed to a single `run()` invocation.
 */
export interface RunOptions {
  /** Optional AbortSignal for cooperative cancellation (user-initiated). */
  signal?: AbortSignal;
  /**
   * Optional internal AbortSignal for gateway-initiated restart.
   * When aborted, the agent returns `{ aborted: true, reason: "internal_restart" }`
   * WITHOUT calling pushAbortAnnotation or discardMailbox.
   * Partial output is discarded (same as retry: nothing lands in context.messages).
   * Internal abort is NOT a user abort — classifyError returns "internal_restart",
   * which is never retryable.
   */
  internalAbortSignal?: AbortSignal;
  /** Optional callback for live stream and lifecycle events. */
  onEvent?: (event: AgentEvent) => void;
  /** Optional mailbox for runtime steering messages. */
  mailbox?: Mailbox;
  /** Optional mutable ref to the abort command string (set by CLI when user types stop/stopp/abort). */
  abortCommand?: { current: string | undefined };
  /** Optional memory backend for ambient hint retrieval. */
  memoryBackend?: MemoryBackend;
  /** Optional metrics recorder for turn/tool/error events. */
  metricsRecorder?: MetricsRecorder;
  /**
   * Optional channel file sender. When present, enables the `send_file` tool.
   * Injected by the daemon when a channel plugin is active for the session.
   */
  channelFileSender?: (sessionId: string, file: { path: string; mimeType: string; caption?: string }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Optional deferred-restart capability for the `request_restart` tool.
   * Injected by the daemon for running sessions; passed through to the
   * ToolCallContext so the tool can schedule a graceful daemon restart.
   */
  requestRestart?: (reason: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Marks this run as a post-restart follow-up turn. The `request_restart`
   * tool refuses to schedule another restart while this flag is set.
   */
  postRestartFollowUp?: boolean;
  /**
   * Optional session scope for per-session tool state (read-before-edit
   * guard). Falls back to `compaction.sessionId`, then to a
   * per-agent-instance default. Never a process-global scope.
   */
  sessionId?: string;
  /**
   * Optional compaction config. When set, auto-compaction triggers before
   * LLM calls. Bound to a single run() invocation — sessionId is specific
   * to this turn, preventing race conditions on shared agents.
   */
  compaction?: CompactionOptions;
  /**
   * Optional channel-specific system-prompt addendum. Appended to the
   * agent's system prompt for this run() invocation WITHOUT mutating the
   * shared agent instance. The addendum is a pure function of the session
   * origin (static text), so the effective system prompt stays
   * byte-identical across turns and daemon restarts.
   */
  systemPromptAddendum?: string;
}

/**
 * Result shape for `run()`.
 *
 * Design rationale: A union type is cleaner than throwing for expected
 * cancellation outcomes (max turns, user abort). Callers can switch on
 * `aborted` without a try/catch. Provider-level errors still throw.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export type RunResult =
  | { aborted: false; turns: number; finalMessage: string; usage: TokenUsage; toolCallCount: number; error?: { type: "provider_aborted"; message: string } }
  | { aborted: true; completedTurns: number; reason: "signal" | "maxTurns" | "internal_restart"; usage: TokenUsage; toolCallCount: number };

/**
 * Events emitted during a streaming run.
 *
 * Mirrors pi-ai's `text_delta` as `token` and adds agent-level lifecycle
 * events for tool calls and turn boundaries.
 */
export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call_start"; name: string; args: unknown }
  | { type: "tool_call_done"; name: string; result: string }
  | { type: "tool_call_error"; name: string; error: string }
  | { type: "status"; status: string }
  | { type: "turn_end"; turn: number }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalTokens: number; callInputTokens: number; callOutputTokens: number; callTotalTokens: number; cacheRead: number; cacheWrite: number; callCacheRead: number; callCacheWrite: number };

function toPiTool(tool: Tool): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function extractUserText(msg: Message): string {
  if (msg.role !== "user") return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join(" ");
  }
  return "";
}

/** Ephemeral user message inserted after the triggering user turn — not persisted. */
function injectMemoryHintMessage(
  messages: Message[],
  anchorUserMessage: Message,
  hintBlock: string,
): Message[] {
  const idx = messages.indexOf(anchorUserMessage);
  if (idx === -1) return messages;
  const hintMessage: Message = {
    role: "user",
    content: hintBlock,
    timestamp: Date.now(),
  };
  return [
    ...messages.slice(0, idx + 1),
    hintMessage,
    ...messages.slice(idx + 1),
  ];
}

function createToolResultMessage(
  toolCall: PiToolCall,
  result: string,
  isError: boolean
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: result }],
    isError,
    timestamp: Date.now(),
  };
}

function drainMailbox(mailbox: Mailbox | undefined, messages: Message[]): void {
  if (!mailbox) return;
  const steers = mailbox.drainAll();
  if (steers.length === 0) return;
  const userInput = steers.map((s) => `"${s}"`).join("\n");
  const content = prompt("steer-annotation", {
    userInput,
    timestamp: new Date().toISOString(),
  });
  messages.push({
    role: "user",
    content: [{ type: "text", text: content }],
    timestamp: Date.now(),
  } as Message);
}

function discardMailbox(mailbox: Mailbox | undefined): void {
  mailbox?.drainAll();
}

function pushAbortAnnotation(
  messages: Message[],
  abortCommand: { current: string | undefined } | undefined
): void {
  if (!abortCommand?.current) return;
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: prompt("abort-annotation", {
          command: abortCommand.current,
          timestamp: new Date().toISOString(),
        }),
      },
    ],
    timestamp: Date.now(),
  } as Message);
}

function findLastAssistantMessageIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      return i;
    }
  }
  return -1;
}

function stripDanglingToolCalls(
  messages: Message[],
  executedToolCallIds: Set<string>
): void {
  const idx = findLastAssistantMessageIndex(messages);
  if (idx === -1) return;
  const msg = messages[idx] as AssistantMessage;
  const newContent = msg.content.filter((c) => {
    if (c.type === "toolCall") {
      return executedToolCallIds.has(c.id);
    }
    return true;
  });
  if (newContent.length === 0) {
    messages.splice(idx, 1);
  } else {
    messages[idx] = { ...msg, content: newContent };
  }
}

async function executeToolWithAbort(
  tool: Tool,
  args: unknown,
  context: ToolCallContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (signal?.aborted) {
    return { content: "Tool execution aborted by user.", isError: true };
  }

  const execution = Promise.resolve(tool.execute(args, context));

  if (!signal) {
    return execution;
  }

  return new Promise<ToolResult>((resolve) => {
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve({ content: "Tool execution aborted by user.", isError: true });
    };

    signal.addEventListener("abort", onAbort, { once: true });

    execution.then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve({
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        });
      },
    );
  });
}


export interface AgentConfig {
  tools: Tool[];
  systemPrompt?: string;
  maxIterations?: number;
  model?: Model<Api>;
  logger?: Logger;
  /** Whether the model emits thinking as inline `simd` tags instead of
   * separate `reasoning_content`. When true, a `ThinkingStreamTransformer`
   * parses `text_delta` chunks for `simd...` segments and routes them
   * as `thinking` events. */
  inlineThinking?: boolean;
  /** Optional sampling parameters forwarded to the provider on every call. */
  temperature?: number;
  maxTokens?: number;
  /** Retry policy for LLM provider calls. Defaults to DEFAULT_RETRY_POLICY. */
  retryPolicy?: RetryPolicy;
}

/**
 * Configuration for auto-compaction within the agent loop.
 */
export interface CompactionOptions {
  /** HarnessPaths — required to write alt-context files to $HARNESS_STATE. */
  paths: HarnessPaths;
  /** Session ID — used for the alt-context file name. */
  sessionId: string;
  /** Override the trigger threshold (default: 0.8 = 80% of contextWindow). */
  threshold?: number;
  /** Override the fraction of recent turns to preserve verbatim (default: 0.2). */
  preserveFraction?: number;
}

export interface Agent {
  run(messages: Message[], options?: RunOptions): Promise<RunResult>;
  setModel(model: Model<Api>): void;
  setSystemPrompt(prompt: string): void;
}

export function createAgent(config: AgentConfig): Agent {
  const { tools, maxIterations = 10, model, logger, inlineThinking = false, temperature, maxTokens, retryPolicy } = config;
  // Caller must set a system prompt via setSystemPrompt(). Empty default
  // is intentional — the prompt template requires `inboxPath`; calling
  // prompt("system-prompt") without vars triggers a missing-variable warning.
  let systemPrompt = config.systemPrompt ?? "";
  let resolvedModel = model ?? resolveModel("minimax", "MiniMax-M2.7");
  const effectiveRetryPolicy = retryPolicy ?? DEFAULT_RETRY_POLICY;
  // Fallback tool-call scope for run() invocations without an explicit
  // sessionId. Scoped to this agent instance — never process-global — so
  // two agents can never share read-before-edit state.
  const defaultToolSessionScope = `agent-${randomUUID()}`;

  return {
    setModel(newModel: Model<Api>) {
      resolvedModel = newModel;
    },
    setSystemPrompt(newPrompt: string) {
      systemPrompt = newPrompt;
    },
    async run(messages: Message[], options: RunOptions = {}): Promise<RunResult> {
      const { signal, internalAbortSignal, onEvent, mailbox, memoryBackend, metricsRecorder, compaction, channelFileSender, requestRestart, postRestartFollowUp, systemPromptAddendum } = options;
      let memoryHintAnchor: Message | undefined;
      let memoryHintBlock: string | undefined;

      // Effective system prompt for THIS turn: base prompt plus the
      // channel addendum (if any). Computed per run() — the shared agent
      // instance is never mutated, so parallel sessions on the same agent
      // cannot leak each other's addendum.
      const effectiveSystemPrompt = systemPromptAddendum
        ? `${systemPrompt}\n\n${systemPromptAddendum}`
        : systemPrompt;

      // Session scope for per-session tool state (read-before-edit guard).
      // Explicit sessionId wins; the daemon's per-run compaction options
      // already carry the sessionId; otherwise fall back to this agent's
      // own scope. Never a process-global scope.
      const toolContext: ToolCallContext = {
        sessionId: options.sessionId ?? compaction?.sessionId ?? defaultToolSessionScope,
        logger: logger,
        channelFileSender,
        requestRestart,
        postRestartFollowUp,
        onStatus: (status) => onEvent?.({ type: "status", status }),
        signal,
      };

      if (memoryBackend) {
        let lastUserIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") {
            lastUserIndex = i;
            break;
          }
        }

        if (lastUserIndex !== -1) {
          const query = extractUserText(messages[lastUserIndex]);
          if (query.trim()) {
            const hints = await memoryBackend.getAmbientHints(query);
            const hintBlock = formatMemoryHint(hints);
            if (hintBlock) {
              memoryHintAnchor = messages[lastUserIndex];
              memoryHintBlock = hintBlock;
            }
          }
        }
      }

      const context: PiContext = {
        systemPrompt: effectiveSystemPrompt,
        messages,
        tools: tools.map(toPiTool),
      };

      const llmContext = (): PiContext => {
        if (!memoryHintAnchor || !memoryHintBlock) return context;
        return {
          ...context,
          messages: injectMemoryHintMessage(context.messages, memoryHintAnchor, memoryHintBlock),
        };
      };

      let totalInput = 0;
      let totalOutput = 0;
      let totalTokens = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let toolCallCount = 0;

      // Compaction cooldown: if a compaction attempt fails, skip retries
      // for 60s to avoid an error loop (shouldCompact stays true after
      // a failed compactSession, which would retry every iteration).
      let compactionCooldownUntil = 0;

      for (let i = 0; i < maxIterations; i++) {
        // Check 0: Internal abort (gateway restart) — BEFORE user signal check.
        // Must not call pushAbortAnnotation or discardMailbox.
        if (internalAbortSignal?.aborted) {
          return { aborted: true, completedTurns: i, reason: "internal_restart", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
        }

        // Check 1: Before LLM call (Turn-Start)
        if (signal?.aborted) {
          discardMailbox(mailbox);
          pushAbortAnnotation(context.messages, options.abortCommand);
          return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
        }

        drainMailbox(mailbox, context.messages);

        // Auto-compaction: if messages exceed threshold, compact before LLM call.
        if (compaction && Date.now() >= compactionCooldownUntil) {
          if (shouldCompact(context.messages, resolvedModel, compaction.threshold, effectiveSystemPrompt, tools.map(toPiTool))) {
            const compactionResult = await compactSession(context.messages, {
              model: resolvedModel,
              paths: compaction.paths,
              sessionId: compaction.sessionId,
              preserveFraction: compaction.preserveFraction,
              signal,
            });
            if (compactionResult.performed) {
              context.messages = compactionResult.messages;
              // Also update the caller's array reference so the compacted
              // messages persist after run() returns.
              messages.length = 0;
              messages.push(...compactionResult.messages);
              logger?.(`[COMPACTION] Compacted ${compactionResult.compactedTurnCount} messages. Alt-context: ${compactionResult.altContextPath}`);
            } else if (compactionResult.compactedTurnCount > 0) {
              // Compaction was attempted but failed (summary error or inflation).
              // Set cooldown to prevent retry loop on next iteration.
              compactionCooldownUntil = Date.now() + 60_000;
              logger?.(`[COMPACTION] Attempt failed, 60s cooldown active. Alt-context: ${compactionResult.altContextPath}`);
            }
          }
        }

        const apiKey = getApiKey(resolvedModel);
        const streamOptions: { apiKey?: string; temperature?: number; maxTokens?: number } = { apiKey };
        if (temperature !== undefined) streamOptions.temperature = temperature;
        if (maxTokens !== undefined) streamOptions.maxTokens = maxTokens;
        const providerStartMs = Date.now();

        let response: AssistantMessage;
        let partialText = "";
        let thinkingTransformer = inlineThinking ? new ThinkingStreamTransformer() : null;
        let retryCount = 0;

        retry_loop: for (;;) {
          // Reset per-attempt state
          partialText = "";
          thinkingTransformer = inlineThinking ? new ThinkingStreamTransformer() : null;

          const timeoutController = new TimeoutController(effectiveRetryPolicy.timeoutMs, signal, internalAbortSignal);

          try {
            const eventStream = stream(resolvedModel, llmContext(), { ...streamOptions, signal: timeoutController.signal });

            for await (const event of eventStream) {
              timeoutController.reset(); // inactivity timer — reset on every chunk

              if (event.type === "text_delta") {
                if (thinkingTransformer) {
                  const outputs = thinkingTransformer.feed(event.delta);
                  for (const out of outputs) {
                    if (out.type === "token") {
                      partialText += out.text;
                      onEvent?.({ type: "token", text: out.text });
                    } else {
                      onEvent?.({ type: "thinking", text: out.text });
                    }
                  }
                } else {
                  partialText += event.delta;
                  onEvent?.({ type: "token", text: event.delta });
                }
              } else if (event.type === "thinking_delta") {
                onEvent?.({ type: "thinking", text: event.delta });
              }
            }

            // Flush any remaining buffered content from the transformer.
            if (thinkingTransformer) {
              for (const out of thinkingTransformer.flush()) {
                if (out.type === "token") {
                  partialText += out.text;
                  onEvent?.({ type: "token", text: out.text });
                } else {
                  onEvent?.({ type: "thinking", text: out.text });
                }
              }
            }

            response = await eventStream.result();

            // Success — clean up timeout controller
            timeoutController.abort();

            traceTokenUsage("provider-response", {
              inputTokens: response.usage.input,
              outputTokens: response.usage.output,
              totalTokens: response.usage.totalTokens,
              cacheRead: response.usage.cacheRead,
              cacheWrite: response.usage.cacheWrite,
            }, { turn: i + 1, model: resolvedModel.name });

            break; // exit retry loop — success
          } catch (err) {
            timeoutController.abort(); // cleanup

            // INTERNAL ABORT (gateway restart) — NOT a user abort.
            // Discard partial output, do NOT call pushAbortAnnotation or discardMailbox.
            if (internalAbortSignal?.aborted) {
              return { aborted: true, completedTurns: i, reason: "internal_restart", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
            }

            // USER ABORT — NEVER retry. Handle exactly as before.
            if (signal?.aborted || (err instanceof Error && err.name === "AbortError" && signal?.aborted)) {
              if (partialText.length > 0) {
                context.messages.push({
                  role: "assistant",
                  content: [{ type: "text", text: partialText }],
                  stopReason: "aborted",
                  provider: resolvedModel.provider,
                  api: resolvedModel.api,
                  model: resolvedModel.name,
                  usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                  timestamp: Date.now(),
                });
              }
              discardMailbox(mailbox);
              pushAbortAnnotation(context.messages, options.abortCommand);
              return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
            }

            // Classify the error
            const errorClass = classifyError(err, signal, internalAbortSignal);

            // Check if retryable
            if (!effectiveRetryPolicy.retryableClasses.includes(errorClass)) {
              // Permanent or user_abort error — fail immediately
              throw err;
            }

            // Check max retries
            if (retryCount >= effectiveRetryPolicy.maxRetries) {
              // Exhausted retries — throw the last error
              throw err;
            }

            // Record retry metric
            retryCount++;
            const retryAfterMs = errorClass === "rate_limit" ? extractRetryAfter(err) : undefined;
            const retryInfo: RetryInfo = {
              attempt: retryCount,
              maxRetries: effectiveRetryPolicy.maxRetries,
              errorClass,
              errorMessage: err instanceof Error ? err.message : String(err),
              retryAfterMs,
              provider: resolvedModel.provider,
              model: resolvedModel.name,
            };
            metricsRecorder?.recordRetry(retryInfo);
            logger?.(`[RETRY] Attempt ${retryCount}/${effectiveRetryPolicy.maxRetries}: ${errorClass} — ${retryInfo.errorMessage}. Waiting ${retryAfterMs ?? computeBackoffDelay(retryCount, effectiveRetryPolicy)}ms`);

            // Wait with backoff (cancellable by user signal)
            const delay = retryAfterMs ?? computeBackoffDelay(retryCount, effectiveRetryPolicy);
            try {
              await sleepCancellable(delay, signal);
            } catch {
              // User aborted during backoff wait — immediate abort, no further retry
              discardMailbox(mailbox);
              pushAbortAnnotation(context.messages, options.abortCommand);
              return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
            }

            // Partial output is already discarded — partialText and thinkingTransformer
            // are reset at the top of the loop. context.messages has NOT been modified
            // with any partial output from the failed attempt (we only push to messages
            // after successful stream completion).
            continue retry_loop;
          }
        }

        totalInput += response.usage.input;
        totalOutput += response.usage.output;
        totalTokens += response.usage.totalTokens;
        totalCacheRead += response.usage.cacheRead;
        totalCacheWrite += response.usage.cacheWrite;
        const cumulativeUsage = {
          inputTokens: totalInput,
          outputTokens: totalOutput,
          totalTokens,
          cacheRead: totalCacheRead,
          cacheWrite: totalCacheWrite,
        };
        traceTokenUsage("agent-result", cumulativeUsage, { turn: i + 1, model: resolvedModel.name });
        onEvent?.({ type: "usage", inputTokens: totalInput, outputTokens: totalOutput, totalTokens, callInputTokens: response.usage.input, callOutputTokens: response.usage.output, callTotalTokens: response.usage.totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, callCacheRead: response.usage.cacheRead, callCacheWrite: response.usage.cacheWrite });

        if (response.stopReason === "error") {
          metricsRecorder?.recordTurn({
            latencyMs: Date.now() - providerStartMs,
            toolCallCount: 0,
            status: "error",
            model: resolvedModel.name,
            inputTokens: response.usage.input,
            outputTokens: response.usage.output,
            totalTokens: response.usage.totalTokens,
            cacheRead: response.usage.cacheRead,
            cacheWrite: response.usage.cacheWrite,
          });
          throw new Error(response.errorMessage ?? "Unbekannter Fehler");
        }

        context.messages.push(response);

        if (response.stopReason === "toolUse") {
          const toolCalls = response.content.filter(
            (c): c is PiToolCall => c.type === "toolCall"
          );

          // Check 2: Before any tool execution — if already aborted, strip
          // dangling tool calls from the assistant message so we don't leave
          // incomplete tool calls in history. Text content is preserved.

          // Internal abort (gateway restart) — no pushAbortAnnotation, no discardMailbox.
          if (internalAbortSignal?.aborted) {
            stripDanglingToolCalls(context.messages, new Set());
            return { aborted: true, completedTurns: i, reason: "internal_restart", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
          }

          if (signal?.aborted) {
            stripDanglingToolCalls(context.messages, new Set());
            discardMailbox(mailbox);
            pushAbortAnnotation(context.messages, options.abortCommand);
            metricsRecorder?.recordTurn({
              latencyMs: Date.now() - providerStartMs,
              toolCallCount: 0,
              status: "aborted",
              model: resolvedModel.name,
              inputTokens: response.usage.input,
              outputTokens: response.usage.output,
              totalTokens: response.usage.totalTokens,
              cacheRead: response.usage.cacheRead,
              cacheWrite: response.usage.cacheWrite,
            });
            return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
          }

          // Build buckets: independent calls get their own bucket;
          // calls sharing the same conflictKey are grouped into one bucket
          // and executed sequentially in original order.
          const buckets: { toolCall: PiToolCall; index: number }[][] = [];
          const conflictMap = new Map<string, { toolCall: PiToolCall; index: number }[]>();

          for (let idx = 0; idx < toolCalls.length; idx++) {
            const toolCall = toolCalls[idx];
            const tool = tools.find((t) => t.name === toolCall.name);
            const key = tool?.conflictKey?.(toolCall.arguments as never);
            if (key == null) {
              buckets.push([{ toolCall, index: idx }]);
            } else {
              const mapKey = `${toolCall.name}::${key}`;
              const existing = conflictMap.get(mapKey);
              if (existing) {
                existing.push({ toolCall, index: idx });
              } else {
                const bucket: { toolCall: PiToolCall; index: number }[] = [{ toolCall, index: idx }];
                conflictMap.set(mapKey, bucket);
                buckets.push(bucket);
              }
            }
          }

          const bucketPromises = buckets.map(async (bucket) => {
            const results: { index: number; message: ToolResultMessage }[] = [];
            for (const { toolCall, index } of bucket) {
              // Check 2b: Before each tool call
              if (signal?.aborted) {
                // Bucket ends cleanly; no further tool calls in this bucket.
                // Parallel buckets are allowed to finish their current calls atomically.
                break;
              }

              const tool = tools.find((t) => t.name === toolCall.name);
              let result: string;
              let isError = false;

              onEvent?.({
                type: "tool_call_start",
                name: toolCall.name,
                args: toolCall.arguments,
              });

              if (!tool) {
                result = `Tool "${toolCall.name}" nicht gefunden.`;
                isError = true;
                logger?.(`[TOOL ERROR] ${toolCall.name}: ${result}`);
                metricsRecorder?.recordToolCall({ tool: toolCall.name, latencyMs: 0, status: "error", error: result });
              } else {
                if (!Value.Check(tool.parameters, toolCall.arguments)) {
                  const validationErrors = Value.Errors(tool.parameters, toolCall.arguments) as Iterable<ValidationErrorLike>;
                  result = formatToolValidationErrors(toolCall.name, validationErrors, toolCall.arguments as Record<string, unknown>);
                  isError = true;
                  logger?.(`[TOOL VALIDATION FAILED] ${toolCall.name}: ${JSON.stringify(toolCall.arguments)}`);
                  metricsRecorder?.recordToolCall({ tool: toolCall.name, latencyMs: 0, status: "error", error: result });
                } else {
                  const toolStart = Date.now();
                  try {
                    if (signal?.aborted) {
                      result = "Tool execution aborted by user.";
                      isError = true;
                      logger?.(`[TOOL ABORT] ${toolCall.name}`);
                      metricsRecorder?.recordToolCall({ tool: toolCall.name, latencyMs: 0, status: "error", error: result });
                    } else {
                      toolCallCount++;
                      const toolResult = await executeToolWithAbort(
                        tool,
                        toolCall.arguments,
                        { ...toolContext, toolCallId: toolCall.id },
                        signal,
                      );
                      result = toolResult.content;
                      if (toolResult.isError) isError = true;
                      const truncated = result.length > 200 ? result.substring(0, 200) + "..." : result;
                      logger?.(`[TOOL CALL] ${toolCall.name}(${JSON.stringify(toolCall.arguments)}) → ${truncated}`);
                      metricsRecorder?.recordToolCall({ tool: toolCall.name, latencyMs: Date.now() - toolStart, status: isError ? "error" : "ok" });
                    }
                  } catch (err) {
                    result = err instanceof Error ? err.message : String(err);
                    isError = true;
                    logger?.(`[TOOL ERROR] ${toolCall.name}: ${result}`);
                    metricsRecorder?.recordToolCall({ tool: toolCall.name, latencyMs: Date.now() - toolStart, status: "error", error: result });
                  }
                }
              }

              results.push({ index, message: createToolResultMessage(toolCall, result, isError) });

              if (isError) {
                onEvent?.({ type: "tool_call_error", name: toolCall.name, error: result });
              } else {
                onEvent?.({ type: "tool_call_done", name: toolCall.name, result });
              }
            }
            return results;
          });

          const settled = await Promise.allSettled(bucketPromises);
          const allResults: { index: number; message: ToolResultMessage }[] = [];
          for (let bIdx = 0; bIdx < settled.length; bIdx++) {
            const s = settled[bIdx]!;
            if (s.status === "fulfilled") {
              allResults.push(...s.value);
            } else {
              // Rejected bucket — log and synthesize error tool results
              // for each tool call in this bucket to avoid dangling tool calls.
              const bucket = buckets[bIdx]!;
              const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
              logger?.(`[BUCKET ERROR] Bucket ${bIdx} rejected: ${errMsg}`);
              for (const { toolCall, index } of bucket) {
                const errorResult = `Tool bucket failed unexpectedly: ${errMsg}`;
                allResults.push({
                  index,
                  message: createToolResultMessage(toolCall, errorResult, true),
                });
                onEvent?.({ type: "tool_call_error", name: toolCall.name, error: errorResult });
              }
            }
          }

          allResults.sort((a, b) => a.index - b.index);
          for (const { message } of allResults) {
            context.messages.push(message);
          }

          onEvent?.({ type: "turn_end", turn: i + 1 });

          // Drain steering messages after tool results are in place.
          // This ensures steer messages appear after tool results, avoiding
          // synthetic tool result insertion by providers like Anthropic.
          drainMailbox(mailbox, context.messages);

          // Check 3: Between iterations (after tool results, before next turn)

          // Internal abort (gateway restart) — no pushAbortAnnotation, no discardMailbox.
          if (internalAbortSignal?.aborted) {
            const executedIds = new Set(allResults.map((r) => r.message.toolCallId));
            stripDanglingToolCalls(context.messages, executedIds);
            return { aborted: true, completedTurns: i, reason: "internal_restart", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
          }

          if (signal?.aborted) {
            const executedIds = new Set(allResults.map((r) => r.message.toolCallId));
            stripDanglingToolCalls(context.messages, executedIds);
            discardMailbox(mailbox);
            pushAbortAnnotation(context.messages, options.abortCommand);
            metricsRecorder?.recordTurn({
              latencyMs: Date.now() - providerStartMs,
              toolCallCount: allResults.length,
              status: "aborted",
              model: resolvedModel.name,
              inputTokens: response.usage.input,
              outputTokens: response.usage.output,
              totalTokens: response.usage.totalTokens,
              cacheRead: response.usage.cacheRead,
              cacheWrite: response.usage.cacheWrite,
            });
            return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
          }

          metricsRecorder?.recordTurn({
            latencyMs: Date.now() - providerStartMs,
            toolCallCount: allResults.length,
            status: "ok",
            model: resolvedModel.name,
            inputTokens: response.usage.input,
            outputTokens: response.usage.output,
            totalTokens: response.usage.totalTokens,
            cacheRead: response.usage.cacheRead,
            cacheWrite: response.usage.cacheWrite,
          });
          continue;
        }

        // Drain steering messages after stream ends, before processing stopReason.
        // This handles steers received during the LLM stream for non-toolUse responses.
        drainMailbox(mailbox, context.messages);

        if (response.stopReason === "stop" || response.stopReason === "length") {
          const textParts = response.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text);
          metricsRecorder?.recordTurn({
            latencyMs: Date.now() - providerStartMs,
            toolCallCount: 0,
            status: "ok",
            model: resolvedModel.name,
            inputTokens: response.usage.input,
            outputTokens: response.usage.output,
            totalTokens: response.usage.totalTokens,
            cacheRead: response.usage.cacheRead,
            cacheWrite: response.usage.cacheWrite,
          });
          return { aborted: false, turns: i + 1, finalMessage: textParts.join(""), usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
        }

        if (response.stopReason === "aborted") {
          metricsRecorder?.recordTurn({
            latencyMs: Date.now() - providerStartMs,
            toolCallCount: 0,
            status: "aborted",
            model: resolvedModel.name,
            inputTokens: response.usage.input,
            outputTokens: response.usage.output,
            totalTokens: response.usage.totalTokens,
            cacheRead: response.usage.cacheRead,
            cacheWrite: response.usage.cacheWrite,
          });
          return {
            aborted: false,
            turns: i + 1,
            finalMessage: "Anfrage wurde abgebrochen.",
            usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite },
            toolCallCount,
            error: { type: "provider_aborted", message: "Provider aborted the generation." },
          };
        }
      }

      discardMailbox(mailbox);
      metricsRecorder?.recordTurn({
        latencyMs: 0,
        toolCallCount: 0,
        status: "aborted",
        model: resolvedModel.name,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      return { aborted: true, completedTurns: maxIterations, reason: "maxTurns", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite }, toolCallCount };
    },
  };
}
