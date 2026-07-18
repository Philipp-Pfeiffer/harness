import type {
  AgentProfileFrontmatter,
  AgentProfileModelRef,
  MemoryZone,
} from "./types.js";

/* ─── Agent Profile Frontmatter Parser ───
 *
 * Parses flat `key: value` frontmatter from agent.md files.
 * Same parsing approach as skills/frontmatter.ts for consistency.
 * Multi-value fields (tools, memory) are comma-separated.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const VALID_ZONES: MemoryZone[] = ["core", "notes"];

const KNOWN_KEYS = new Set([
  "name",
  "model",
  "thinking",
  "tools",
  "memory",
  "skills",
  "temperature",
  "maxTokens",
]);

export class AgentProfileFrontmatterError extends Error {
  constructor(filePath: string, message: string) {
    super(`${filePath}: ${message}`);
    this.name = "AgentProfileFrontmatterError";
  }
}

/**
 * Parses flat `key: value` frontmatter lines. Blank lines and `#`
 * comments are ignored. Values may be single- or double-quoted.
 */
function parseFields(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf(":");
    if (sep === -1) continue; // skip non-key-value lines gracefully
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    fields.set(key, value);
  }
  return fields;
}

function parseBoolean(
  filePath: string,
  key: string,
  raw: string | undefined,
  defaultValue: boolean | undefined,
): boolean | undefined {
  if (raw === undefined || raw === "") return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new AgentProfileFrontmatterError(
    filePath,
    `invalid value for "${key}": "${raw}" — expected true|false`,
  );
}

/**
 * Parses a comma-separated list field. Returns undefined when the key is
 * absent; an empty array when it is present but empty (explicit opt-out).
 */
function parseList(fields: Map<string, string>, key: string): string[] | undefined {
  if (!fields.has(key)) return undefined;
  const raw = fields.get(key);
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseModelRef(filePath: string, raw: string): AgentProfileModelRef {
  const sep = raw.indexOf("/");
  const provider = sep === -1 ? "" : raw.slice(0, sep).trim();
  const model = sep === -1 ? "" : raw.slice(sep + 1).trim();
  if (!provider || !model) {
    throw new AgentProfileFrontmatterError(
      filePath,
      `invalid model "${raw}" — expected "provider/model-id"`,
    );
  }
  return { provider, model };
}

function parseMemoryZones(
  filePath: string,
  raw: string[] | undefined,
): MemoryZone[] | undefined {
  if (raw === undefined) return undefined;
  const zones: MemoryZone[] = [];
  for (const zone of raw) {
    if (!VALID_ZONES.includes(zone as MemoryZone)) {
      throw new AgentProfileFrontmatterError(
        filePath,
        `invalid memory zone "${zone}" — expected ${VALID_ZONES.join("|")}`,
      );
    }
    zones.push(zone as MemoryZone);
  }
  return zones;
}

function parseNumber(
  filePath: string,
  key: string,
  raw: string | undefined,
  opts: { integer: boolean },
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (opts.integer && !Number.isInteger(value))) {
    throw new AgentProfileFrontmatterError(
      filePath,
      `invalid value for "${key}": "${raw}" — expected a ${opts.integer ? "non-negative integer" : "non-negative number"}`,
    );
  }
  return value;
}

/**
 * Substitutes `{{var}}` placeholders in the profile body for known vars.
 * Unknown placeholders are left intact.
 */
export function substituteVars(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in vars ? vars[key]! : match,
  );
}

/**
 * Parses an agent.md file's frontmatter and body.
 * Throws AgentProfileFrontmatterError on validation failures.
 */
export function parseAgentProfileFile(
  filePath: string,
  content: string,
  dirname: string,
  vars: Record<string, string> = {},
): {
  frontmatter: AgentProfileFrontmatter;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new AgentProfileFrontmatterError(
      filePath,
      "missing frontmatter block (--- ... ---)",
    );
  }
  const fields = parseFields(match[1]!);
  const rawBody = match[2]!;

  for (const key of fields.keys()) {
    if (!KNOWN_KEYS.has(key)) {
      throw new AgentProfileFrontmatterError(
        filePath,
        `unknown frontmatter key: "${key}"`,
      );
    }
  }

  // name (required, must match folder)
  const name = fields.get("name");
  if (!name) {
    throw new AgentProfileFrontmatterError(filePath, "missing required field: name");
  }
  if (!NAME_RE.test(name)) {
    throw new AgentProfileFrontmatterError(
      filePath,
      `invalid name "${name}" — must be lowercase-hyphenated (e.g. "my-profile")`,
    );
  }
  if (name !== dirname) {
    throw new AgentProfileFrontmatterError(
      filePath,
      `name "${name}" does not match folder name "${dirname}"`,
    );
  }

  // model (optional, "provider/model-id")
  const modelRaw = fields.get("model");
  const model = modelRaw ? parseModelRef(filePath, modelRaw) : undefined;

  // thinking (optional, default: inherit from model config)
  const thinking = parseBoolean(filePath, "thinking", fields.get("thinking"), undefined);

  // tools (optional allowlist; absent = full set, empty = none)
  const tools = parseList(fields, "tools");

  // memory (optional zone list; absent = all zones, empty = none)
  const memory = parseMemoryZones(filePath, parseList(fields, "memory"));

  // skills (optional, default true)
  const skills = parseBoolean(filePath, "skills", fields.get("skills"), true)!;

  // sampling parameters (optional)
  const temperature = parseNumber(filePath, "temperature", fields.get("temperature"), { integer: false });
  const maxTokens = parseNumber(filePath, "maxTokens", fields.get("maxTokens"), { integer: true });

  const body = substituteVars(rawBody, vars).trim();
  if (!body) {
    throw new AgentProfileFrontmatterError(
      filePath,
      "empty body — agent profiles need a persona prompt",
    );
  }

  return {
    frontmatter: { name, model, thinking, tools, memory, skills, temperature, maxTokens },
    body,
  };
}
