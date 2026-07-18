import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { CronPattern } from "croner";

/* ─── Cron Job File Format ───
 *
 * Job files live in `$HARNESS_STATE/jobs/*.md` and consist of a flat
 * key-value frontmatter block followed by a free-text body:
 *
 *   ---
 *   name: metrics-rotation
 *   schedule: 0 3 * * *
 *   enabled: true
 *   type: script
 *   jitter: 2h
 *   ---
 *   metrics-rotation
 *
 * Frontmatter keys:
 * - name     (required) human-readable job name
 * - schedule (required) cron expression (5 or 6 fields, croner syntax)
 * - enabled  (optional, default true) "true" | "false"
 * - type     (required) "agent" | "script"
 * - jitter   (optional) max random start delay per run, e.g. "30m", "2h"
 * - agent    (optional, type=agent only) agent profile name — the job's
 *            session runs with that profile's prompt, model and tools.
 *            Default: "default".
 *
 * Body: prompt text for type=agent, registry function name for type=script.
 */

export type CronJobType = "agent" | "script";

export interface CronJob {
  name: string;
  schedule: string;
  enabled: boolean;
  type: CronJobType;
  /** Max random start delay per run, in milliseconds. 0 = no jitter. */
  jitterMs: number;
  /** Agent profile name for type=agent jobs. Absent = "default". */
  agent?: string;
  /** Prompt text (agent) or script registry function name (script). */
  body: string;
  /** Path of the job file this job was loaded from. */
  filePath: string;
}

export class CronJobParseError extends Error {
  constructor(filePath: string, message: string) {
    super(`${filePath}: ${message}`);
    this.name = "CronJobParseError";
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i;

const PROFILE_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses a duration string like "500ms", "30s", "15m", "2h" or "1d"
 * into milliseconds. Throws on malformed input.
 */
export function parseDurationMs(raw: string): number {
  const match = raw.trim().match(DURATION_RE);
  if (!match) {
    throw new Error(
      `invalid duration "${raw}" — expected <number><unit>, unit one of ms|s|m|h|d`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  return value * DURATION_UNIT_MS[unit]!;
}

/**
 * Parses flat `key: value` frontmatter lines. Blank lines and `#`
 * comments are ignored. Values may be single- or double-quoted.
 */
function parseFrontmatterFields(
  filePath: string,
  raw: string,
): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf(":");
    if (sep === -1) {
      throw new CronJobParseError(filePath, `malformed frontmatter line: "${trimmed}"`);
    }
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
      throw new CronJobParseError(filePath, `duplicate frontmatter key: "${key}"`);
    }
    fields.set(key, value);
  }
  return fields;
}

function parseEnabled(filePath: string, raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new CronJobParseError(filePath, `invalid enabled value "${raw}" — expected true|false`);
}

/**
 * Parses a single cron job file. Validates required fields, the cron
 * schedule (via croner) and the optional jitter duration.
 * Throws CronJobParseError on any problem.
 */
export function parseCronJobFile(filePath: string, content: string): CronJob {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new CronJobParseError(filePath, "missing frontmatter block (--- ... ---)");
  }
  const fields = parseFrontmatterFields(filePath, match[1]!);
  const body = match[2]!.trim();

  const name = fields.get("name");
  if (!name) {
    throw new CronJobParseError(filePath, "missing required field: name");
  }

  const schedule = fields.get("schedule");
  if (!schedule) {
    throw new CronJobParseError(filePath, "missing required field: schedule");
  }
  try {
    // Throws on invalid patterns — validation only.
    new CronPattern(schedule);
  } catch (err) {
    throw new CronJobParseError(
      filePath,
      `invalid schedule "${schedule}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const type = fields.get("type");
  if (type !== "agent" && type !== "script") {
    throw new CronJobParseError(
      filePath,
      `missing or invalid type "${type ?? ""}" — expected agent|script`,
    );
  }

  const enabled = parseEnabled(filePath, fields.get("enabled"));

  const agent = fields.get("agent");
  if (agent !== undefined && !PROFILE_NAME_RE.test(agent)) {
    throw new CronJobParseError(
      filePath,
      `invalid agent "${agent}" — must be a profile name (lowercase-hyphenated, e.g. "distillation")`,
    );
  }

  const jitterRaw = fields.get("jitter");
  let jitterMs = 0;
  if (jitterRaw !== undefined && jitterRaw !== "") {
    try {
      jitterMs = parseDurationMs(jitterRaw);
    } catch (err) {
      throw new CronJobParseError(
        filePath,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (!body) {
    throw new CronJobParseError(
      filePath,
      type === "agent"
        ? "empty body — agent jobs need a prompt"
        : "empty body — script jobs need a function name",
    );
  }

  return { name, schedule, enabled, type, jitterMs, agent, body, filePath };
}

export interface CronJobsLoadResult {
  jobs: CronJob[];
  /** One human-readable error message per file that failed to parse. */
  errors: string[];
}

/**
 * Loads and parses all `*.md` job files from a directory.
 * Never throws: a missing/unreadable directory or broken files are
 * reported via `errors` instead, so the daemon keeps running.
 */
export async function loadCronJobs(dir: string): Promise<CronJobsLoadResult> {
  const jobs: CronJob[] = [];
  const errors: string[] = [];

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { jobs, errors };
    errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return { jobs, errors };
  }

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const content = await readFile(filePath, "utf-8");
      jobs.push(parseCronJobFile(filePath, content));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { jobs, errors };
}
