import type { Tool } from "./types.js";
import { echoTool } from "./echo.js";
import { readFileTool } from "./readFile.js";
import { bashTool } from "./bash.js";

export function loadTools(): Tool[] {
  return [echoTool, readFileTool, bashTool];
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
