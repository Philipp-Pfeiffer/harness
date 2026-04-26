import { complete, getModel } from "@mariozechner/pi-ai";
import { Value } from "typebox/value";
import type {
  Context as PiContext,
  Tool as PiTool,
  ToolCall as PiToolCall,
  UserMessage,
  ToolResultMessage,
  TextContent,
  Model,
  Api,
} from "@mariozechner/pi-ai";
import type { Tool } from "../tools/types.js";

export interface ToolCallLog {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
}

export type Logger = (msg: string) => void;

function toPiTool(tool: Tool): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function createUserMessage(content: string): UserMessage {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
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
  run(input: string): Promise<string>;
}

export function createAgent(config: AgentConfig): Agent {
  const { tools, systemPrompt, maxIterations = 10, model, logger } = config;
  const resolvedModel = model ?? getModel("minimax", "MiniMax-M2.7");

  return {
    async run(input: string): Promise<string> {
      const context: PiContext = {
        systemPrompt,
        messages: [createUserMessage(input)],
        tools: tools.map(toPiTool),
      };

      for (let i = 0; i < maxIterations; i++) {
        const response = await complete(resolvedModel, context);

        context.messages.push(response);

        if (response.stopReason === "stop" || response.stopReason === "length") {
          const textParts = response.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text);
          return textParts.join("");
        }

        if (response.stopReason === "toolUse") {
          const toolCalls = response.content.filter(
            (c): c is PiToolCall => c.type === "toolCall"
          );

          for (const toolCall of toolCalls) {
            const tool = tools.find((t) => t.name === toolCall.name);
            let result: string;
            let isError = false;

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

            context.messages.push(createToolResultMessage(toolCall, result, isError));
          }

          continue;
        }

        if (response.stopReason === "error") {
          throw new Error(response.errorMessage ?? "Unbekannter Fehler");
        }

        if (response.stopReason === "aborted") {
          return "Anfrage wurde abgebrochen.";
        }
      }

      return "Maximale Anzahl an Iterationen erreicht.";
    },
  };
}