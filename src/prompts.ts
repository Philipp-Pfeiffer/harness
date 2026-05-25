import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export function prompt(name: string, vars: Record<string, string> = {}): string {
  let raw = readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8");
  raw = raw.replace(/^\s*<!--[\s\S]*?-->\s*/i, "");
  return raw.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`prompt(${name}): missing variable "${k}"`);
    return vars[k];
  });
}
