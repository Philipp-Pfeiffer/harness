import { stream, getModel } from "@mariozechner/pi-ai";
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
} from "@mariozechner/pi-ai";
import type { Tool } from "../tools/types.js";

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

export interface AgentConfig {
  tools: Tool[];
  systemPrompt?: string;
  maxIterations?: number;
  model?: Model<Api>;
  logger?: Logger;
}

export interface Agent {
  run(messages: Message[], options?: RunOptions): Promise<RunResult>;
}

export function createAgent(config: AgentConfig): Agent {
  const { tools, systemPrompt, maxIterations = 10, model, logger } = config;
  const resolvedModel = model ?? getModel("minimax", "MiniMax-M2.7");

  return {
    async run(messages: Message[], options: RunOptions = {}): Promise<RunResult> {
      const { signal, onEvent } = options;
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
          return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
        }

        const eventStream = stream(resolvedModel, context, { signal });
        let response: import("@mariozechner/pi-ai").AssistantMessage;

        try {
          for await (const event of eventStream) {
            if (event.type === "text_delta") {
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

        if (response.stopReason === "stop" || response.stopReason === "length") {
          const textParts = response.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text);
          return { aborted: false, turns: i + 1, finalMessage: textParts.join(""), usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
        }

        if (response.stopReason === "aborted") {
          return { aborted: false, turns: i + 1, finalMessage: "Anfrage wurde abgebrochen.", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
        }

        if (response.stopReason === "toolUse") {
          const toolCalls = response.content.filter(
            (c): c is PiToolCall => c.type === "toolCall"
          );

          // Check 2: Before any tool execution — if already aborted, roll back
          // the assistant message so we don't leave dangling tool calls in history.
          if (signal?.aborted) {
            context.messages.pop();
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

          // Check 3: Between iterations (after tool results, before next turn)
          if (signal?.aborted) {
            return { aborted: true, completedTurns: i, reason: "signal", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
          }

          continue;
        }
      }

      return { aborted: true, completedTurns: maxIterations, reason: "maxTurns", usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens } };
    },
  };
}
