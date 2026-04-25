import { complete, getModel } from "@mariozechner/pi-ai";
import type {
  Context as PiContext,
  Tool as PiTool,
  ToolCall as PiToolCall,
  UserMessage,
  ToolResultMessage,
  TextContent,
} from "@mariozechner/pi-ai";
import type { Tool } from "../tools/types.js";

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
}

export interface Agent {
  run(input: string): Promise<string>;
}

const model = getModel("minimax", "MiniMax-M2.7");

export function createAgent(config: AgentConfig): Agent {
  const { tools, systemPrompt, maxIterations = 10 } = config;

  return {
    async run(input: string): Promise<string> {
      const context: PiContext = {
        systemPrompt,
        messages: [createUserMessage(input)],
        tools: tools.map(toPiTool),
      };

      for (let i = 0; i < maxIterations; i++) {
        const response = await complete(model, context);

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
            } else {
              try {
                result = await Promise.resolve(tool.execute(toolCall.arguments));
              } catch (err) {
                result = err instanceof Error ? err.message : String(err);
                isError = true;
              }
            }

            context.messages.push(createToolResultMessage(toolCall, result, isError));
          }

          continue;
        }

        if (response.stopReason === "error" || response.stopReason === "aborted") {
          return `Fehler: ${response.errorMessage || "Unbekannter Fehler"}`;
        }
      }

      return "Maximale Anzahl an Iterationen erreicht.";
    },
  };
}
