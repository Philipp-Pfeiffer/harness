import type { Tool } from "./types.js";
import type { MemoryBackend } from "../core/memoryBackend.js";
import type { WebConfig } from "../config.js";
import type { SkillRecord } from "../skills/types.js";
import type { FindSkillToolOptions } from "./findSkill.js";
import { readFileTool } from "./readFile.js";
import { execTool } from "./exec.js";
import { processTool } from "./process.js";
import { writeTool } from "./write_file.js";
import { editTool } from "./edit_file.js";
import { createSearchMemoryTool } from "./searchMemory.js";
import { createWebSearchTool } from "./web_search.js";
import { createWebFetchTool } from "./web_fetch.js";
import { createLoadSkillTool } from "./loadSkill.js";
import { createFindSkillTool } from "./findSkill.js";

export interface LoadToolsOptions {
  memoryBackend?: MemoryBackend;
  webConfig?: WebConfig;
  /** Loaded skill records for load_skill / find_skill tools. */
  skills?: SkillRecord[];
  /** Skills directory path (for telemetry). */
  skillsDir?: string;
  /** Optional QMD store for find_skill search. */
  findSkillStore?: FindSkillToolOptions["store"];
}

export function loadTools(opts?: LoadToolsOptions): Tool[];
/** @deprecated Use loadTools with options object. */
export function loadTools(memoryBackend?: MemoryBackend, webConfig?: WebConfig): Tool[];
export function loadTools(
  arg1?: MemoryBackend | LoadToolsOptions,
  webConfig?: WebConfig,
): Tool[] {
  // Normalize to options object (backward compat with old signature)
  const opts: LoadToolsOptions =
    arg1 !== undefined && typeof arg1 === "object" && "memoryBackend" in arg1
      ? (arg1 as LoadToolsOptions)
      : {
          memoryBackend: arg1 as MemoryBackend | undefined,
          webConfig,
        };

  const tools: Tool[] = [
    readFileTool,
    execTool,
    processTool,
    writeTool,
    editTool,
    createSearchMemoryTool(opts.memoryBackend),
    createWebSearchTool(opts.webConfig),
    createWebFetchTool(opts.webConfig),
  ];

  if (opts.skills && opts.skills.length > 0) {
    tools.push(
      createLoadSkillTool(opts.skills, opts.skillsDir ?? ""),
      createFindSkillTool(opts.skills, { store: opts.findSkillStore }),
    );
  }

  return tools;
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
