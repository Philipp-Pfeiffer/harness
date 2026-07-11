import type { Tool } from "./types.js";
import type { MemoryBackend } from "../core/memoryBackend.js";
import type { WebConfig } from "../config.js";
import { readFileTool } from "./readFile.js";
import { execTool } from "./exec.js";
import { processTool } from "./process.js";
import { writeTool } from "./write_file.js";
import { editTool } from "./edit_file.js";
import { createSearchMemoryTool } from "./searchMemory.js";
import { createWebSearchTool } from "./web_search.js";
import { createWebFetchTool } from "./web_fetch.js";

export function loadTools(memoryBackend?: MemoryBackend, webConfig?: WebConfig): Tool[] {
  return [
    readFileTool,
    execTool,
    processTool,
    writeTool,
    editTool,
    createSearchMemoryTool(memoryBackend),
    createWebSearchTool(webConfig),
    createWebFetchTool(webConfig),
  ];
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
