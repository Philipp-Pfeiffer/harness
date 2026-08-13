import type { ConfigModel } from "../config.js";
import { resolveModelFromConfig } from "../core/resolveModel.js";
import type { ResolvedModel } from "../core/resolveModel.js";
import { prompt } from "../prompts.js";
import type { Tool } from "../tools/types.js";
import { isOpenRouterPresetRef, parseModelRef } from "../browser/config.js";

/**
 * Subagent roles: role name → persona prompt file, tool set and default
 * model. New roles are added as a new prompt file + one map entry — no new
 * tool files, no runner changes.
 */
export interface SubagentRoleConfig {
  /** Prompt file name in packages/core/prompts (without .md). */
  promptFile: string;
  /** Tool names granted to this role. */
  toolNames: string[];
  /** Default model ref (provider/model or @preset/...). */
  defaultModelRef: string;
}

export type SubagentRoleName = "coder";

/** Tool names that are never granted to subagents (channel/browser/image). */
const CHANNEL_TOOLS = new Set([
  "send_file",
  "send_sticker",
  "call_user",
  "report_to_main_session",
  "request_restart",
  "hang_up",
]);

/** Tool names that are never granted to subagents (browser/image subsystems). */
const SUBSYSTEM_TOOLS = new Set(["browser", "image"]);

export const subagentRoles: Record<SubagentRoleName, SubagentRoleConfig> = {
  coder: {
    promptFile: "subagent-coder",
    toolNames: ["readFile", "write", "edit", "exec", "process"],
    defaultModelRef: "@preset/deepseek-flash",
  },
};

export function resolveRolePrompt(role: string): string {
  const config = subagentRoles[role as SubagentRoleName];
  if (!config) {
    throw new Error(`Unknown subagent role "${role}". Known roles: ${Object.keys(subagentRoles).join(", ")}`);
  }
  return prompt(config.promptFile);
}

/**
 * Role tools are the base tool array filtered to the role's toolNames,
 * minus channel/subsystem tools (belt and braces — a role's toolNames
 * should never list them in the first place).
 */
export function resolveRoleTools(role: string, loadedTools: Tool[]): Tool[] {
  const config = subagentRoles[role as SubagentRoleName];
  if (!config) {
    throw new Error(`Unknown subagent role "${role}". Known roles: ${Object.keys(subagentRoles).join(", ")}`);
  }
  const allowed = new Set(config.toolNames);
  return loadedTools.filter(
    (t) => allowed.has(t.name) && !CHANNEL_TOOLS.has(t.name) && !SUBSYSTEM_TOOLS.has(t.name),
  );
}

/**
 * Model resolution for a role: explicit override > role default > daemon
 * default model. Supports @preset/ refs via config.models lookup
 * (same pattern as the browser runner).
 */
export function resolveRoleModel(
  role: string,
  overrideModelRef?: string,
  opts: { models?: ConfigModel[]; defaultModel?: ConfigModel } = {},
): ResolvedModel {
  const config = subagentRoles[role as SubagentRoleName];
  if (!config) {
    throw new Error(`Unknown subagent role "${role}". Known roles: ${Object.keys(subagentRoles).join(", ")}`);
  }
  const modelRef = overrideModelRef ?? config.defaultModelRef;

  const fromModels = opts.models?.find((m) => m.model === modelRef);
  if (fromModels) {
    return resolveModelFromConfig(fromModels);
  }

  if (isOpenRouterPresetRef(modelRef)) {
    // Fall back to the daemon default before failing — the role default
    // preset is only a preference.
    if (opts.defaultModel) {
      return resolveModelFromConfig(opts.defaultModel);
    }
    throw new Error(
      `Unknown OpenRouter preset "${modelRef}". Add it to config.models in $HARNESS_HOME/config.json.`,
    );
  }

  const { provider, model: modelId } = parseModelRef(modelRef);
  const fromConfig = opts.models?.find((m) => m.provider === provider && m.model === modelId);
  if (fromConfig) {
    return resolveModelFromConfig(fromConfig);
  }
  if (opts.defaultModel) {
    return resolveModelFromConfig(opts.defaultModel);
  }
  throw new Error(`Subagent model "${modelRef}" not found in config.models.`);
}
