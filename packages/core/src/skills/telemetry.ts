import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SkillTelemetry, SkillTelemetryEntry } from "./types.js";

/* ─── Telemetry Sidecar ───
 *
 * Reads/writes $HARNESS_HOME/skills/_telemetry.json.
 * Tracks per-skill: uses, last_used, patches, pinned.
 * Never throws — missing/corrupt file returns empty telemetry.
 */

const EMPTY_ENTRY: SkillTelemetryEntry = {
  uses: 0,
  last_used: null,
  patches: 0,
  pinned: false,
};

/**
 * Reads the telemetry sidecar file. Returns an empty record if
 * the file does not exist or is corrupt.
 */
export async function readTelemetry(telemetryPath: string): Promise<SkillTelemetry> {
  try {
    const raw = await readFile(telemetryPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    // Validate shape — be lenient, skip invalid entries
    const result: SkillTelemetry = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val !== "object" || val === null) continue;
      const entry = val as Record<string, unknown>;
      result[key] = {
        uses: typeof entry.uses === "number" ? entry.uses : 0,
        last_used:
          typeof entry.last_used === "string" ? entry.last_used : null,
        patches: typeof entry.patches === "number" ? entry.patches : 0,
        pinned: typeof entry.pinned === "boolean" ? entry.pinned : false,
      };
    }
    return result;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    // Corrupt JSON or other error — return empty rather than throwing
    return {};
  }
}

/**
 * Writes the telemetry sidecar file. Creates parent directories if needed.
 */
export async function writeTelemetry(
  telemetryPath: string,
  telemetry: SkillTelemetry,
): Promise<void> {
  const data = JSON.stringify(telemetry, null, 2) + "\n";
  await writeFile(telemetryPath, data, "utf-8");
}

/**
 * Increments the use count for a skill and updates last_used timestamp.
 * Writes the updated telemetry to disk. Never throws.
 */
export async function recordSkillUse(
  telemetryPath: string,
  skillName: string,
  now: Date = new Date(),
): Promise<void> {
  let telemetry: SkillTelemetry;
  try {
    telemetry = await readTelemetry(telemetryPath);
  } catch {
    telemetry = {};
  }

  const existing = telemetry[skillName] ?? { ...EMPTY_ENTRY };
  telemetry[skillName] = {
    ...existing,
    uses: existing.uses + 1,
    last_used: now.toISOString(),
  };

  try {
    await writeTelemetry(telemetryPath, telemetry);
  } catch {
    // Best-effort — telemetry is non-critical
  }
}

/**
 * Returns the telemetry path inside the skills directory.
 */
export function telemetryPathFor(skillsDir: string): string {
  return join(skillsDir, "_telemetry.json");
}
