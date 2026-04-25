import type { Tool } from "./types.js";
import { echoTool } from "./echo.js";

export function loadTools(): Tool[] {
  return [echoTool];
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
