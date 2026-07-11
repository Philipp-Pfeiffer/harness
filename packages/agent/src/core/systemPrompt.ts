import { prompt } from "@harness/core";
import { formatCoreMemoryBlock } from "./coreMemory.js";

export interface BuildSystemPromptOptions {
  basePrompt: string;
  coreMemoryRaw?: string;
  activeToolNames: string[];
}

/**
 * Composes the final system prompt from the base prompt, optional core memory,
 * and conditional safety layers.
 *
 * The web-content-safety layer is injected only when web_fetch or web_search
 * are in the active tool set, keeping prompts short when those tools are disabled.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const { basePrompt, coreMemoryRaw, activeToolNames } = options;

  const hasWebTools = activeToolNames.some(
    (name) => name === "web_fetch" || name === "web_search"
  );

  const coreBlock = formatCoreMemoryBlock(coreMemoryRaw);
  const safetyBlock = hasWebTools ? formatWebContentSafetyBlock() : "";

  return [basePrompt, coreBlock, safetyBlock].filter(Boolean).join("\n\n");
}

function formatWebContentSafetyBlock(): string {
  return prompt("web-content-safety");
}
