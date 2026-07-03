/**
 * Public library surface for Harness.
 *
 * This module is the only entry point intended for external consumers.
 * It deliberately does not import the TUI (`index.tsx`) or CLI modules so
 * that library usage (e.g. `file:../harness`) does not trigger the TTY guard
 * or pull in React/Ink.
 */

// Agent core
export {
  createAgent,
  type Agent,
  type AgentConfig,
  type AgentEvent,
  type RunOptions,
  type RunResult,
  type TokenUsage,
} from "./core/agent.js";

// Tool types and individual tools
export { type Tool } from "./tools/types.js";
export { readFileTool } from "./tools/readFile.js";
export { execTool } from "./tools/exec.js";
export { processTool } from "./tools/process.js";
export { writeTool } from "./tools/write_file.js";
export { editTool } from "./tools/edit_file.js";
export { createWebSearchTool } from "./tools/web_search.js";
export { createWebFetchTool } from "./tools/web_fetch.js";
export { loadTools, findTool } from "./tools/registry.js";

// Model resolution
export {
  resolveModel,
  resolveModelFromConfig,
  getApiKey,
  type ResolvedModel,
} from "./core/resolveModel.js";

// Prompts
export { prompt } from "./prompts.js";

// Note on toolChoice (pi-ai 0.70.2):
// The typed `StreamOptions` interface does not expose a `toolChoice` field.
// However, `ProviderStreamOptions` is defined as `StreamOptions & Record<string, unknown>`,
// so unknown options can be forwarded to providers. Several provider implementations
// internally reference `tool_choice` / `toolChoice`. This means tool-forcing is not
// part of the stable public type surface in 0.70.2; any use of it would rely on
// provider-specific, untyped passthrough.
