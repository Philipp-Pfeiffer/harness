import type { Tool } from "../tools/types.js";

export interface AgentConfig {
  tools: Tool[];
  systemPrompt?: string;
  maxIterations?: number;
}

export interface Agent {
  run(input: string): Promise<string>;
}

export function createAgent(config: AgentConfig): Agent {
  const { tools, systemPrompt, maxIterations = 10 } = config;

  return {
    async run(input: string): Promise<string> {
      // TODO: implement the agent loop
      // 1. Build context (system prompt + user input + history)
      // 2. Call LLM via @mariozechner/pi-ai
      // 3. Parse tool calls from response
      // 4. Validate & execute tools
      // 5. Append results to context
      // 6. Repeat until maxIterations or stop condition

      console.log(`[Cliffford] Received input: ${input}`);
      console.log(`[Cliffford] Available tools: ${tools.map((t) => t.name).join(", ")}`);
      console.log(`[Cliffford] Max iterations: ${maxIterations}`);
      if (systemPrompt) {
        console.log(`[Cliffford] System prompt set`);
      }

      return "Cliffford V2 is alive but the loop is not wired yet.";
    },
  };
}
