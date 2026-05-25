import { stream } from "@mariozechner/pi-ai";
import { resolveModel } from "./resolveModel.js";
import { prompt } from "../prompts.js";
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
import type { Tool } from "../tools/types.js";
import type { Mailbox } from "./mailbox.js";

export interface ToolCallLog {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
}

export type Logger = (msg: string) => void;



/**
 * Options passed to a single `run()` invocation.
 */
export interface RunOptions {
  /** Optional AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
  /** Optional callback for live stream and lifecycle events. */
  onEvent?: (event: AgentEvent) => void;
  /** Optional mailbox for runtime steering messages. */
  mailbox?: Mailbox;
  /** Optional mutable ref to the abort command string (set by CLI when user types stop/stopp/abort). */
  abortCommand?: { current: string | undefined };
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
}

export type RunResult =
  | { aborted: false; turns: number; finalMessage: string; usage: TokenUsage }
  | { aborted: true; completedTurns: number; reason: "signal" | "maxTurns"; usage: TokenUsage };

/**
 * Events emitted during a streaming run.
 *
 * Mirrors pi-ai's `text_delta` as `token` and adds agent-level lifecycle
 * events for tool calls and turn boundaries.
 */
export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_call_start"; name: string; args: unknown }
  | { type: "tool_call_done"; name: string; result: string }
  | { type: "tool_call_error"; name: string; error: string }
  | { type: "turn_end"; turn: number }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalTokens: number };

function toPiTool(tool: Tool): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
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

const DEFAULT_SYSTEM_PROMPT = `Du bist ein hilfreicher Assistent in einer Terminal-UI.
- Antworte in knapper Prosa.
- Verzichte auf Markdown-Überschriften (#, ##, ###).
- Nutze Bullet-Listen (-) für Aufzählungen.
- Code-Blöcke (\`\`\`) und Inline-Code (\`) sind erwünscht.
- Fett (**text**), kursiv (*text*) und Tabellen (| ... |) sind explizit erlaubt und erwünscht.`;

export interface AgentConfig {
  tools: Tool[];
  systemPrompt?: string;
  maxIterations?: number;
  model?: Model<Api>;
  logger?: Logger;
}

export interface Agent {
  run(messages: Message[], options?: RunOptions): Promise<RunResult>;
  setModel(model: Model<Api>): void;
}

export function createAgent(config: AgentConfig): Agent {
  const { tools, systemPrompt = DEFAULT_SYSTEM_PROMPT, maxIterations = 10, model, logger } = config;
  let resolvedModel = model ?? resolveModel("minimax", "MiniMax-M2.7");

  return {
    setModel(newModel: Model<Api>) {
      resolvedModel = newModel;
    },
    async run(messages: Message[], options: RunOptions = {}): Promise<RunResult> {
      const { signal, onEvent, mailbox } = options;
      const context: PiContext = {
        systemPrompt,
        messages,
        tools: tools.map(toPiTool),
      };

      let totalInput = 0;
      let totalOutput = 0;
      let totalTokens = 0;

      for (let i = 0; i < maxIterations; i++) {
        // Check 1: Before LLM call (Turn-Start)
        if (signal?.aborted) {
          discardMailbox(mailbox);
          pushAbortAnnotation(context.messages, options.abortCommand);
          return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
        }

        drainMailbox(mailbox, context.messages);

        const eventStream = stream(resolvedModel, context, { signal });
        let response: AssistantMessage;
        let partialText = "";

        try {
          for await (const event of eventStream) {
            if (event.type === "text_delta") {
              partialText += event.delta;
              onEvent?.({ type: "token", text: event.delta });
            }
          }
          response = await eventStream.result();
        } catch (err) {
          // If the signal triggered the cancellation, return gracefully.
          // pi-ai may throw an AbortError or the signal may simply be set.
          if (
            signal?.aborted ||
            (err instanceof Error && err.name === "AbortError")
          ) {
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
            return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
          }
          throw err;
        }

        totalInput += response.usage.input;
        totalOutput += response.usage.output;
        totalTokens += response.usage.totalTokens;
        onEvent?.({ type: "usage", inputTokens: totalInput, outputTokens: totalOutput, totalTokens });

        if (response.stopReason === "error") {
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
          if (signal?.aborted) {
            stripDanglingToolCalls(context.messages, new Set());
            discardMailbox(mailbox);
            pushAbortAnnotation(context.messages, options.abortCommand);
            return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
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
              } else {
                if (!Value.Check(tool.parameters, toolCall.arguments)) {
                  result = `Argumente für Tool "${toolCall.name}" sind ungültig.`;
                  isError = true;
                  logger?.(`[TOOL VALIDATION FAILED] ${toolCall.name}: ${JSON.stringify(toolCall.arguments)}`);
                } else {
                  try {
                    // Tool calls are atomic: once started they run to completion
                    // even if the signal is aborted mid-flight.
                    result = await Promise.resolve(tool.execute(toolCall.arguments));
                    const truncated = result.length > 200 ? result.substring(0, 200) + "..." : result;
                    logger?.(`[TOOL CALL] ${toolCall.name}(${JSON.stringify(toolCall.arguments)}) → ${truncated}`);
                  } catch (err) {
                    result = err instanceof Error ? err.message : String(err);
                    isError = true;
                    logger?.(`[TOOL ERROR] ${toolCall.name}: ${result}`);
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
          for (const s of settled) {
            if (s.status === "fulfilled") {
              allResults.push(...s.value);
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
          if (signal?.aborted) {
            const executedIds = new Set(allResults.map((r) => r.message.toolCallId));
            stripDanglingToolCalls(context.messages, executedIds);
            discardMailbox(mailbox);
            pushAbortAnnotation(context.messages, options.abortCommand);
            return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
          }

          continue;
        }

        // Drain steering messages after stream ends, before processing stopReason.
        // This handles steers received during the LLM stream for non-toolUse responses.
        drainMailbox(mailbox, context.messages);

        if (response.stopReason === "stop" || response.stopReason === "length") {
          const textParts = response.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text);
          return { aborted: false, turns: i + 1, finalMessage: textParts.join(""), usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
        }

        if (response.stopReason === "aborted") {
          return { aborted: false, turns: i + 1, finalMessage: "Anfrage wurde abgebrochen.", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
        }
      }

      discardMailbox(mailbox);
      return { aborted: true, completedTurns: maxIterations, reason: "maxTurns", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
    },
  };
}
