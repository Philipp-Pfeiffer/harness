import type { Tool } from "./types.js";
import { readFileTool } from "./readFile.js";
import { execTool } from "./exec.js";
import { processTool } from "./process.js";
import { writeTool } from "./write_file.js";
import { editTool } from "./edit_file.js";

export function loadTools(): Tool[] {
  return [readFileTool, execTool, processTool, writeTool, editTool];
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
