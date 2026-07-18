import { ALL_MEMORY_ZONES, type MemoryZone } from "@harness/core";
import { formatCoreMemoryBlock } from "./coreMemory.js";

export interface ComposeProfilePromptOptions {
  /** Bare base prompt (runtime conventions), always first. */
  basePrompt: string;
  /** Persona prompt from the agent profile body. */
  persona: string;
  /** Raw core.md content; wrapped in a <core_memory> block when the "core" zone is granted. */
  coreMemoryRaw?: string;
  /** Rendered skill hot-set block; appended when the profile has skills enabled. */
  hotSetBlock?: string;
  /** Memory zones the profile grants. Defaults to all zones. */
  memoryZones?: MemoryZone[];
  /** Whether the skill hot-set is enabled for the profile. Default true. */
  skillsHotSet?: boolean;
}

/**
 * Composes the system prompt for a profile session:
 * bare base prompt + persona + (core memory block if zone granted)
 * + (skill hot-set if enabled).
 *
 * For the "default" profile this reproduces the previous daemon prompt
 * (persona = former system-prompt.md content), plus the bare base prefix.
 */
export function composeProfilePrompt(options: ComposeProfilePromptOptions): string {
  const zones = options.memoryZones ?? ALL_MEMORY_ZONES;
  const skillsHotSet = options.skillsHotSet ?? true;

  const parts = [options.basePrompt, options.persona];

  if (zones.includes("core")) {
    parts.push(formatCoreMemoryBlock(options.coreMemoryRaw));
  }
  if (skillsHotSet && options.hotSetBlock) {
    parts.push(options.hotSetBlock);
  }

  return parts.filter(Boolean).join("\n\n");
}
