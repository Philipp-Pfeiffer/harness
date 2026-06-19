import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveHarnessPaths } from "../config/paths.js";

export type ConfigModel = { provider: string; model: string; alias: string };

const DEFAULT_MODELS: ConfigModel[] = [
  { provider: "minimax", model: "MiniMax-M2.7", alias: "MiniMax M2.7" },
];

/**
 * Loads model configuration from a prioritized list of candidate locations.
 *
 * Lookup order (first match wins):
 * 1. `options.configPath` (explicit CLI flag)
 * 2. `$HARNESS_HOME/config.json` (durable substrate, portable)
 * 3. `<cwd>/harness.config.json` (legacy cwd-based, deprecated)
 * 4. `$XDG_CONFIG_HOME/harness/config.json` (XDG convention)
 * 5. `~/.harness/config.json` (legacy home fallback)
 *
 * `options.homeDir` is an override for testing only.
 */
export async function loadConfig(options?: {
  configPath?: string;
  cwd?: string;
  homeDir?: string;
  xdgConfigHome?: string;
}): Promise<{
  models: ConfigModel[];
  error?: string;
  source?: string;
}> {
  const cwd = options?.cwd ?? process.cwd();
  const xdgConfigHome = options?.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const homeDir = options?.homeDir ?? os.homedir();

  const harnessHome = resolveHarnessPaths().home;

  const candidates: { path: string; source: string }[] = [];

  if (options?.configPath) {
    candidates.push({ path: options.configPath, source: "cli" });
  }

  // HARNESS_HOME/config.json — the new primary location
  candidates.push({ path: path.join(harnessHome, "config.json"), source: "harness-home" });

  // Legacy: cwd-based config
  candidates.push({ path: path.join(cwd, "harness.config.json"), source: "cwd" });

  if (xdgConfigHome) {
    candidates.push({ path: path.join(xdgConfigHome, "harness", "config.json"), source: "xdg" });
  }

  candidates.push({ path: path.join(homeDir, ".harness", "config.json"), source: "home" });

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate.path, "utf-8");
      const config = JSON.parse(raw) as { models?: ConfigModel[] };
      if (config.models && Array.isArray(config.models) && config.models.length > 0) {
        return { models: config.models, source: candidate.source };
      }
      return { models: DEFAULT_MODELS, error: "Config has no models, using default", source: candidate.source };
    } catch {
      // try next candidate
    }
  }

  return {
    models: DEFAULT_MODELS,
    error: "No config found, using default model",
  };
}
