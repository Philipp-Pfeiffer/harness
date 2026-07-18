import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentProfile,
  AgentProfileLoadResult,
  AgentProfileError,
} from "./types.js";
import {
  parseAgentProfileFile,
  AgentProfileFrontmatterError,
} from "./frontmatter.js";

/* ─── Agent Profile Loader ───
 *
 * Scans directories for profile subdirectories containing agent.md.
 * Validates each profile, collects errors without throwing.
 * Never throws — broken profiles are reported via errors[].
 */

export interface LoadAgentProfilesOptions {
  /** Directory containing user profile subdirectories (e.g. $HARNESS_HOME/agents/). */
  profilesDir: string;
  /** Built-in profiles directory (shipped with the package). Lower priority than user profiles. */
  builtinDir?: string;
  /** Variables substituted into profile bodies (e.g. inboxPath). */
  vars?: Record<string, string>;
}

/**
 * Scans a single directory for profile subdirectories with agent.md files.
 * Returns partial results — errors are collected, never thrown.
 */
async function scanDirectory(
  dir: string,
  builtin: boolean,
  vars: Record<string, string>,
): Promise<{ profiles: AgentProfile[]; errors: AgentProfileError[] }> {
  const profiles: AgentProfile[] = [];
  const errors: AgentProfileError[] = [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { profiles, errors };
    errors.push({
      profileName: "(directory)",
      filePath: dir,
      message: `Failed to read profiles directory: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { profiles, errors };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderName = entry.name;
    // Skip hidden directories
    if (folderName.startsWith(".") || folderName.startsWith("_")) continue;

    const profileDir = join(dir, folderName);
    const agentMdPath = join(profileDir, "agent.md");

    try {
      const content = await readFile(agentMdPath, "utf-8");
      const parsed = parseAgentProfileFile(agentMdPath, content, folderName, vars);

      profiles.push({
        name: parsed.frontmatter.name,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        filePath: agentMdPath,
        dir: profileDir,
        builtin,
      });
    } catch (err) {
      if (err instanceof AgentProfileFrontmatterError) {
        errors.push({
          profileName: folderName,
          filePath: agentMdPath,
          message: err.message,
        });
      } else {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // Directory without agent.md — skip silently
          continue;
        }
        errors.push({
          profileName: folderName,
          filePath: agentMdPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { profiles, errors };
}

/**
 * Loads and validates all agent profiles from the user profiles directory
 * and optionally a built-in profiles directory. User profiles override
 * built-in profiles with the same name. Never throws — broken profiles
 * are collected in errors[].
 */
export async function loadAgentProfiles(
  opts: LoadAgentProfilesOptions,
): Promise<AgentProfileLoadResult> {
  const allProfiles: AgentProfile[] = [];
  const allErrors: AgentProfileError[] = [];
  const vars = opts.vars ?? {};

  // Load built-in profiles first (lower priority)
  if (opts.builtinDir) {
    const builtinResult = await scanDirectory(opts.builtinDir, true, vars);
    allProfiles.push(...builtinResult.profiles);
    allErrors.push(...builtinResult.errors);
  }

  // Load user profiles (higher priority — overrides built-ins)
  const userResult = await scanDirectory(opts.profilesDir, false, vars);
  allProfiles.push(...userResult.profiles);
  allErrors.push(...userResult.errors);

  // Deduplicate: user profiles override built-in profiles with the same name
  const byName = new Map<string, AgentProfile>();
  for (const profile of allProfiles) {
    byName.set(profile.name, profile);
  }

  return {
    profiles: Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    errors: allErrors,
  };
}
