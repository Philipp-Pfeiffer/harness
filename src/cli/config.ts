import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ConfigModel = { provider: string; model: string; alias: string };

const DEFAULT_MODELS: ConfigModel[] = [
  { provider: "minimax", model: "MiniMax-M2.7", alias: "MiniMax M2.7" },
];

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
  const cwd = options?.cwd ?? process.env.HARNESS_PROJECT_ROOT ?? process.cwd();
  const xdgConfigHome = options?.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const homeDir = options?.homeDir ?? os.homedir();

  const candidates: { path: string; source: string }[] = [];

  if (options?.configPath) {
    candidates.push({ path: options.configPath, source: "cli" });
  }

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
