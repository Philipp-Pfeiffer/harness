import { readFile } from "node:fs/promises";

export interface CoreMemorySections {
  wer: string;
  projekte: string;
  workingProtocol: string;
  aktiveThemen: string;
}

/**
 * Reads core.md and returns its raw content.
 * Returns undefined if the file does not exist, logging a warning.
 *
 * @param corePath  Absolute path to core.md (from HarnessPaths.core).
 *                  Required — no cwd/projectRoot fallback.
 */
export async function loadCoreMemoryRaw(corePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(corePath, "utf-8");
    return content.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT")) {
      console.warn(`[coreMemory] core.md not found at ${corePath}. Using empty core memory block.`);
      return undefined;
    }
    throw err;
  }
}

/**
 * Parses the raw core.md content into structured sections.
 * Sections are identified by ## headings (case-insensitive).
 */
export function parseCoreMemorySections(raw: string): CoreMemorySections {
  const sections: CoreMemorySections = {
    wer: "",
    projekte: "",
    workingProtocol: "",
    aktiveThemen: "",
  };

  const regex = /^##\s+(.*?)\s*\n([\s\S]*?)(?=^##\s|$)/gm;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const heading = match[1].trim().toLowerCase();
    const body = match[2].trim();
    if (heading === "wer") sections.wer = body;
    else if (heading === "projekte") sections.projekte = body;
    else if (heading === "working-protocol" || heading === "working protocol") sections.workingProtocol = body;
    else if (heading === "aktive-themen" || heading === "aktive themen") sections.aktiveThemen = body;
  }

  return sections;
}

/**
 * Formats core memory content for injection into the system prompt.
 * Wraps it in a <core_memory> block. If no content is provided, returns
 * an empty <core_memory/> block.
 */
export function formatCoreMemoryBlock(raw?: string): string {
  if (!raw || raw.length === 0) {
    return "<core_memory></core_memory>";
  }
  return `<core_memory>\n${raw}\n</core_memory>`;
}

/**
 * Composes a full system prompt by appending the core memory block
 * to the base system prompt.
 */
export function composeSystemPrompt(basePrompt: string, coreMemoryRaw?: string): string {
  const block = formatCoreMemoryBlock(coreMemoryRaw);
  return `${basePrompt}\n\n${block}`;
}
