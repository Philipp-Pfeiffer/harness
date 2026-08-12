import type { SkillFrontmatter, SkillLevel, SkillStatus } from "./types.js";

/* ─── Skill Frontmatter Parser ───
 *
 * Parses flat `key: value` frontmatter from skill.md files.
 * Reuses the same parsing approach as daemon/jobs.ts for consistency.
 * Multi-value fields (requires) are comma-separated.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class SkillFrontmatterError extends Error {
  constructor(filePath: string, message: string) {
    super(`${filePath}: ${message}`);
    this.name = "SkillFrontmatterError";
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
    if (fields.has(key)) {
      // Last value wins — mirrors jobs.ts behavior
    }
    fields.set(key, value);
  }
  return fields;
}

function parseBoolean(
  filePath: string,
  key: string,
  raw: string | undefined,
  defaultValue: boolean,
): boolean {
  if (raw === undefined || raw === "") return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new SkillFrontmatterError(
    filePath,
    `invalid value for "${key}": "${raw}" — expected true|false`,
  );
}

function parseList(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parses a skill.md file's frontmatter and body.
 * Throws SkillFrontmatterError on validation failures.
 */
export function parseSkillFile(
  filePath: string,
  content: string,
  dirname: string,
): {
  frontmatter: SkillFrontmatter;
  body: string;
  tokenEstimate: number;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new SkillFrontmatterError(
      filePath,
      "missing frontmatter block (--- ... ---)",
    );
  }
  const fields = parseFields(match[1]!);
  const body = match[2]!;

  // name (required, must match folder)
  const name = fields.get("name");
  if (!name) {
    throw new SkillFrontmatterError(filePath, "missing required field: name");
  }
  if (!NAME_RE.test(name)) {
    throw new SkillFrontmatterError(
      filePath,
      `invalid name "${name}" — must be lowercase-hyphenated (e.g. "my-skill")`,
    );
  }
  if (name !== dirname) {
    throw new SkillFrontmatterError(
      filePath,
      `name "${name}" does not match folder name "${dirname}"`,
    );
  }

  // description (required)
  const description = fields.get("description");
  if (!description) {
    throw new SkillFrontmatterError(
      filePath,
      "missing required field: description",
    );
  }

  // level (required)
  const levelRaw = fields.get("level");
  if (levelRaw !== "atom" && levelRaw !== "molecule") {
    throw new SkillFrontmatterError(
      filePath,
      `missing or invalid level "${levelRaw ?? ""}" — expected atom|molecule`,
    );
  }
  const level: SkillLevel = levelRaw;

  // requires (optional, comma-separated)
  const requires = parseList(fields.get("requires"));

  // status (optional, default active)
  const statusRaw = fields.get("status") ?? "active";
  const validStatuses: SkillStatus[] = ["draft", "active", "stale", "archive"];
  if (!validStatuses.includes(statusRaw as SkillStatus)) {
    throw new SkillFrontmatterError(
      filePath,
      `invalid status "${statusRaw}" — expected ${validStatuses.join("|")}`,
    );
  }
  const status = statusRaw as SkillStatus;

  // pinned (optional, default false)
  const pinned = parseBoolean(filePath, "pinned", fields.get("pinned"), false);

  // routable (optional, default true)
  const routable = parseBoolean(
    filePath,
    "routable",
    fields.get("routable"),
    true,
  );

  // disabled (optional, default false) — operator switch-off
  const disabled = parseBoolean(
    filePath,
    "disabled",
    fields.get("disabled"),
    false,
  );

  const tokenEstimate = Math.ceil(content.length / 4);

  return {
    frontmatter: {
      name,
      description,
      level,
      requires,
      status,
      pinned,
      routable,
      disabled,
    },
    body,
    tokenEstimate,
  };
}
