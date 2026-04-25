import type { Tool } from "./types.js";

// Import your concrete tools here
// import { readFileTool } from "./readFile.js";
// import { bashTool } from "./bash.js";

export function loadTools(): Tool[] {
  const tools: Tool[] = [
    // readFileTool,
    // bashTool,
    // …add more
  ];
  return tools;
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
