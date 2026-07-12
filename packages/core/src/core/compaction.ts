import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { complete, type Context as PiContext } from "@mariozechner/pi-ai";
import { prompt } from "../prompts.js";
import { getApiKey } from "./resolveModel.js";
import type { Model, Api, Message, AssistantMessage } from "@mariozechner/pi-ai";
import type { ResolvedModel } from "./resolveModel.js";
import type { HarnessPaths } from "../config/paths.js";

/**
 * Configuration for context compaction.
 */
export interface CompactionConfig {
  /**
   * Fraction of the model's context window at which auto-compaction triggers.
   * Default: 0.8 (80%).
   */
  threshold: number;
}

export const DEFAULT_COMPACTION_THRESHOLD = 0.8;

/**
 * Options for compactSession().
 */
export interface CompactSessionOptions {
  /** The model to use for both context-window sizing and the summary LLM call. */
  model: Model<Api>;
  /** HarnessPaths — used to write the alt-context file into $HARNESS_STATE. */
  paths: HarnessPaths;
  /** Session ID — used for the alt-context file name. */
  sessionId: string;
  /** Optional AbortSignal for the compaction LLM call. */
  signal?: AbortSignal;
  /** Override the fraction of turns to preserve verbatim (default: 0.2 = last 20%). */
  preserveFraction?: number;
  /** Override the compaction threshold (default: 0.8). */
  threshold?: number;
}

/**
 * Result of a compaction operation.
 */
export interface CompactSessionResult {
  /** The new message array with old turns replaced by the summary. */
  messages: Message[];
  /** Number of turns that were compacted. */
  compactedTurnCount: number;
  /** Path to the alt-context file containing the full, uncompacted history. */
  altContextPath: string;
  /** Whether compaction was actually performed (false = skipped, messages unchanged). */
  performed: boolean;
}

/**
 * Estimates token count for a message array.
 * Uses the same heuristic as session.ts: ~4 chars/token + 3 tokens/message.
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += 3;
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            chars += part.text.length;
          }
        }
      }
    } else if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") {
          chars += part.text.length;
        } else if (part.type === "toolCall") {
          chars += JSON.stringify(part.arguments).length;
          chars += part.name.length;
        }
      }
    } else if (msg.role === "toolResult") {
      for (const c of msg.content) {
        if (c.type === "text") {
          chars += c.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Checks whether compaction should be triggered.
 * Returns true if estimated tokens exceed threshold * contextWindow.
 */
export function shouldCompact(
  messages: Message[],
  model: Model<Api>,
  threshold: number = DEFAULT_COMPACTION_THRESHOLD,
): boolean {
  const contextWindow = (model as ResolvedModel).contextWindow ?? 128_000;
  const tokens = estimateTokens(messages);
  return tokens >= threshold * contextWindow;
}

/**
 * Finds the split point for compaction.
 * Keeps the last `preserveFraction` of messages (by token count),
 * rounded up to a minimum of 2 messages. Ensures the split happens
 * at a natural boundary (after an assistant message or before a user message).
 */
export function findSplitPoint(
  messages: Message[],
  preserveFraction: number = 0.2,
): number {
  if (messages.length <= 4) return messages.length;

  const totalTokens = estimateTokens(messages);
  const targetPreserved = totalTokens * preserveFraction;

  // Walk backwards, accumulating tokens until we hit the target.
  let accumulated = 0;
  let splitIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens([messages[i]!]);
    if (accumulated + msgTokens > targetPreserved && i < messages.length - 2) {
      break;
    }
    accumulated += msgTokens;
    splitIndex = i;
  }

  // Ensure at least the last 2 messages are preserved.
  const minPreserve = Math.min(2, messages.length);
  if (messages.length - splitIndex < minPreserve) {
    splitIndex = messages.length - minPreserve;
  }

  // Advance splitIndex to a natural boundary: not in the middle of a
  // tool-call / tool-result sequence. We want splitIndex to point at
  // the first message of the "keep" section, which should be a user message
  // or the start of a new turn.
  while (
    splitIndex < messages.length &&
    messages[splitIndex] &&
    (messages[splitIndex]!.role === "toolResult" ||
      (messages[splitIndex]!.role === "assistant" &&
        splitIndex > 0 &&
        messages[splitIndex - 1]?.role === "toolResult"))
  ) {
    splitIndex++;
  }

  return splitIndex;
}

/**
 * Serializes an array of Message objects into a human-readable Markdown string
 * for the alt-context file.
 */
function messagesToMarkdown(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    lines.push(`## ${role}`);
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        lines.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            lines.push(part.text);
          }
        }
      }
    } else if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") {
          lines.push(part.text);
        } else if (part.type === "toolCall") {
          lines.push(`[Tool Call: ${part.name}(${JSON.stringify(part.arguments)})]`);
        }
      }
    } else if (msg.role === "toolResult") {
      for (const c of msg.content) {
        if (c.type === "text") {
          lines.push(`[Tool Result: ${c.text}]`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Writes the alt-context file to $HARNESS_STATE.
 * Returns the path to the written file.
 */
function writeAltContext(
  paths: HarnessPaths,
  sessionId: string,
  messages: Message[],
): string {
  const dir = path.join(paths.state, "compaction");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.md`);
  const content = `# Alt-Context for Session ${sessionId}\n\nThis file contains the full, uncompacted conversation history that was compacted to save context window space.\nThe agent can use readFile to retrieve details from this file.\n\n---\n\n${messagesToMarkdown(messages)}`;
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

/**
 * Calls the LLM to generate a compaction summary.
 */
async function generateSummary(
  model: Model<Api>,
  messagesToCompress: Message[],
  altContextPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const compactionPrompt = prompt("compaction", { altContextPath });

  // Serialize the messages to compress into a single user message.
  const conversationText = messagesToMarkdown(messagesToCompress);

  const context: PiContext = {
    systemPrompt: compactionPrompt,
    messages: [
      {
        role: "user",
        content: `Summarize the following conversation. The full history is available at ${altContextPath}.\n\n---\n\n${conversationText}`,
        timestamp: Date.now(),
      },
    ],
  };

  const apiKey = getApiKey(model);
  const response = await complete(model, context, { signal, apiKey });

  const textParts = response.content.filter(
    (c): c is { type: "text"; text: string } => c.type === "text",
  );
  return textParts.map((c) => c.text).join("\n");
}

/**
 * Compacts the oldest turns of a session's message history into a summary turn.
 *
 * This function:
 * 1. Finds the split point (older messages to compact vs. recent to preserve)
 * 2. Writes the compacted messages to an alt-context file in $HARNESS_STATE
 * 3. Calls the LLM with a dedicated compaction prompt
 * 4. Replaces the old messages with a summary message + the preserved recent tail
 *
 * The persisted transcript (JSONL) is NOT modified — compaction only affects
 * the working context that gets sent to the LLM.
 *
 * Returns the new message array. If compaction was not needed or failed,
 * the original messages are returned unchanged.
 */
export async function compactSession(
  messages: Message[],
  options: CompactSessionOptions,
): Promise<CompactSessionResult> {
  const {
    model,
    paths,
    sessionId,
    signal,
    preserveFraction = 0.2,
  } = options;

  const splitIndex = findSplitPoint(messages, preserveFraction);

  // Nothing to compact (not enough messages or all recent).
  if (splitIndex <= 1 || splitIndex >= messages.length) {
    return {
      messages,
      compactedTurnCount: 0,
      altContextPath: "",
      performed: false,
    };
  }

  const messagesToCompress = messages.slice(0, splitIndex);
  const messagesToKeep = messages.slice(splitIndex);

  // Write alt-context file.
  const altContextPath = writeAltContext(paths, sessionId, messagesToCompress);

  // Generate the summary via LLM.
  let summary: string;
  try {
    summary = await generateSummary(model, messagesToCompress, altContextPath, signal);
  } catch (err) {
    // If compaction fails, return original messages unchanged.
    // The alt-context file still exists for manual recovery.
    return {
      messages,
      compactedTurnCount: messagesToCompress.length,
      altContextPath,
      performed: false,
    };
  }

  // Inflation check: if the summary + recent context is not smaller,
  // skip compaction (return original).
  const compactedMessages: Message[] = [
    {
      role: "user",
      content: `--- Compacted Context ---\n\n${summary}\n\n--- End of Compacted Context ---\nFull conversation history is available at: ${altContextPath}`,
      timestamp: Date.now(),
    } as Message,
    {
      role: "assistant",
      content: [{ type: "text", text: "Got it. I have the compacted context and will continue from here." }],
      stopReason: "stop",
      provider: (model as ResolvedModel).provider,
      api: model.api,
      model: model.name,
      usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    } as AssistantMessage,
    ...messagesToKeep,
  ];

  // Inflation check.
  const originalTokens = estimateTokens(messages);
  const compactedTokens = estimateTokens(compactedMessages);
  if (compactedTokens >= originalTokens) {
    return {
      messages,
      compactedTurnCount: messagesToCompress.length,
      altContextPath,
      performed: false,
    };
  }

  return {
    messages: compactedMessages,
    compactedTurnCount: messagesToCompress.length,
    altContextPath,
    performed: true,
  };
}
