import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SkillRecord, SkillLoadResult, SkillError } from "./types.js";
import { parseSkillFile, SkillFrontmatterError } from "./frontmatter.js";

/* ─── Skill Loader ───
 *
 * Scans a directory for skill subdirectories containing skill.md.
 * Validates each skill, collects errors without throwing.
 * Never throws — broken skills are reported via errors[].
 */

/** Token threshold for the "skill.md too large" warning. */
const TOKEN_WARNING_THRESHOLD = 1200;

export interface LoadSkillsOptions {
  /** Directory containing skill subdirectories (e.g. $HARNESS_HOME/skills/). */
  skillsDir: string;
  /** Built-in skills directory (shipped with the package). Lower priority than user skills. */
  builtinDir?: string;
}

/**
 * Scans a single directory for skill subdirectories with skill.md files.
 * Returns partial results — errors are collected, never thrown.
 */
async function scanDirectory(
  dir: string,
  builtin: boolean,
): Promise<{ skills: SkillRecord[]; errors: SkillError[]; warnings: string[] }> {
  const skills: SkillRecord[] = [];
  const errors: SkillError[] = [];
  const warnings: string[] = [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { skills, errors, warnings };
    errors.push({
      skillName: "(directory)",
      filePath: dir,
      message: `Failed to read skills directory: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { skills, errors, warnings };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderName = entry.name;
    // Skip hidden directories and the telemetry sidecar
    if (folderName.startsWith(".") || folderName.startsWith("_")) continue;

    const skillDir = join(dir, folderName);
    const skillMdPath = join(skillDir, "skill.md");

    try {
      const content = await readFile(skillMdPath, "utf-8");
      const parsed = parseSkillFile(skillMdPath, content, folderName);

      // Check for optional subdirectories
      let hasScripts = false;
      let hasReferences = false;
      let hasEvals = false;
      try {
        const subEntries = await readdir(skillDir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          if (sub.name === "scripts") hasScripts = true;
          if (sub.name === "references") hasReferences = true;
          if (sub.name === "evals") hasEvals = true;
        }
      } catch {
        // If we can't read subdirs, skip silently
      }

      // Token warning
      if (parsed.tokenEstimate > TOKEN_WARNING_THRESHOLD) {
        warnings.push(
          `${skillMdPath}: skill.md is ~${parsed.tokenEstimate} tokens (threshold: ${TOKEN_WARNING_THRESHOLD}). Consider splitting.`,
        );
      }

      skills.push({
        name: parsed.frontmatter.name,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        filePath: skillMdPath,
        dir: skillDir,
        builtin,
        tokenEstimate: parsed.tokenEstimate,
        hasScripts,
        hasReferences,
        hasEvals,
      });
    } catch (err) {
      if (err instanceof SkillFrontmatterError) {
        errors.push({
          skillName: folderName,
          filePath: skillMdPath,
          message: err.message,
        });
      } else {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // Directory without skill.md — skip silently
          continue;
        }
        errors.push({
          skillName: folderName,
          filePath: skillMdPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { skills, errors, warnings };
}

/**
 * Loads and validates all skills from the skills directory and optionally
 * a built-in skills directory. User skills override built-in skills with
 * the same name. Never throws — broken skills are collected in errors[].
 */
export async function loadSkills(
  opts: LoadSkillsOptions,
): Promise<SkillLoadResult> {
  const allSkills: SkillRecord[] = [];
  const allErrors: SkillError[] = [];
  const allWarnings: string[] = [];

  // Load built-in skills first (lower priority)
  if (opts.builtinDir) {
    const builtinResult = await scanDirectory(opts.builtinDir, true);
    allSkills.push(...builtinResult.skills);
    allErrors.push(...builtinResult.errors);
    allWarnings.push(...builtinResult.warnings);
  }

  // Load user skills (higher priority — overrides built-ins)
  const userResult = await scanDirectory(opts.skillsDir, false);
  allSkills.push(...userResult.skills);
  allErrors.push(...userResult.errors);
  allWarnings.push(...userResult.warnings);

  // Deduplicate: user skills override built-in skills with the same name
  const byName = new Map<string, SkillRecord>();
  for (const skill of allSkills) {
    byName.set(skill.name, skill);
  }

  return {
    skills: Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    errors: allErrors,
    warnings: allWarnings,
  };
}

/**
 * Validates requires references: all referenced skills must exist,
 * and dependency depth must be ≤ 1 (a required skill must not itself
 * have requires).
 *
 * Returns a list of error messages (empty if all valid).
 */
export function validateRequires(skills: SkillRecord[]): string[] {
  const errors: string[] = [];
  const byName = new Map(skills.map((s) => [s.name, s]));

  for (const skill of skills) {
    for (const required of skill.frontmatter.requires) {
      const target = byName.get(required);
      if (!target) {
        errors.push(
          `${skill.name}: requires "${required}" which does not exist`,
        );
        continue;
      }

      // Depth check: the required skill must not itself have requires
      if (target.frontmatter.requires.length > 0) {
        errors.push(
          `${skill.name}: requires "${required}" which itself has requires — max depth 1 violated`,
        );
      }
    }
  }

  return errors;
}

/**
 * Computes which skills are routable (discoverable via find_skill).
 *
 * Rules:
 * - A skill with routable=false is not routable.
 * - An atom with incoming requires (required by another skill) is not routable
 *   — it can only be reached via its parent.
 */
export function computeRoutableSkills(skills: SkillRecord[]): Set<string> {
  // Build incoming requires map
  const incomingRequires = new Set<string>();
  for (const skill of skills) {
    for (const required of skill.frontmatter.requires) {
      incomingRequires.add(required);
    }
  }

  const routable = new Set<string>();
  for (const skill of skills) {
    if (!skill.frontmatter.routable) continue;
    // Atoms with incoming requires are not routable
    if (
      skill.frontmatter.level === "atom" &&
      incomingRequires.has(skill.name)
    ) {
      continue;
    }
    routable.add(skill.name);
  }

  return routable;
}
