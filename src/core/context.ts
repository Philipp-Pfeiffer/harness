/**
 * Context management for the agent loop.
 * Holds message history, token bookkeeping, and metadata.
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  name?: string; // for tool messages
  tool_call_id?: string;
}

export interface Context {
  messages: Message[];
  tokenCount: number;
}

export function createContext(systemPrompt?: string): Context {
  const messages: Message[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  return {
    messages,
    tokenCount: 0,
  };
}

export function addMessage(ctx: Context, msg: Message): void {
  ctx.messages.push(msg);
  // TODO: update tokenCount via tiktoken or pi-ai utilities
}

export function trimContext(ctx: Context, maxTokens: number): void {
  // TODO: sliding window / summarization strategy
  while (ctx.tokenCount > maxTokens && ctx.messages.length > 1) {
    ctx.messages.splice(1, 1); // keep system message
    ctx.tokenCount = 0; // recalc
  }
}
