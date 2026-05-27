import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

const FALLBACK_PROMPT =
  "Du bist ein hilfreicher Assistent in einer Terminal-UI. " +
  "Antworte in knapper Prosa, verzichte auf Markdown-Überschriften.";

export function prompt(name: string, vars: Record<string, string> = {}): string {
  let raw: string;
  try {
    raw = readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[prompts] Failed to load "${name}.md": ${message}. Using fallback.`);
    return FALLBACK_PROMPT;
  }

  raw = raw.replace(/^\s*<!--[\s\S]*?-->\s*/i, "");
  return raw.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) {
      console.warn(`[prompts] Missing variable "${k}" for prompt "${name}". Using empty string.`);
      return "";
    }
    return vars[k];
  });
}
