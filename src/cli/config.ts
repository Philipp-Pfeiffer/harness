import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveHarnessPaths } from "../config/paths.js";

export type OpenAiApiType = "openai-completions" | "openai-responses";

export type ConfigProvider = {
  type: "openai";
  baseUrl: string;
  apiKey?: string;
};

export type ConfigModel = {
  provider: string;
  model: string;
  alias: string;
  api?: OpenAiApiType;
  baseUrl?: string;
  apiKey?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};

export type Config = {
  models?: ConfigModel[];
  providers?: Record<string, ConfigProvider>;
  defaultModel?: ConfigModel;
};

const DEFAULT_MODELS: ConfigModel[] = [
  { provider: "minimax", model: "MiniMax-M2.7", alias: "MiniMax M2.7" },
];

const DEFAULT_PROVIDERS: Record<string, ConfigProvider> = {};

function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const envValue = process.env[name];
      if (envValue === undefined) {
        throw new Error(`Missing environment variable: ${name}`);
      }
      return envValue;
    });
  }

  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = expandEnvVars(val);
    }
    return result;
  }

  return value;
}

function mergeProviderDefaults(
  models: ConfigModel[],
  providers: Record<string, ConfigProvider>,
): ConfigModel[] {
  return models.map((model) => {
    const provider = providers[model.provider];
    if (!provider) return model;

    return {
      ...model,
      api: model.api ?? (provider.type === "openai" ? "openai-completions" : undefined),
      baseUrl: model.baseUrl ?? provider.baseUrl,
      apiKey: model.apiKey ?? provider.apiKey,
    };
  });
}

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
  harnessHome?: string;
}): Promise<{
  models: ConfigModel[];
  providers: Record<string, ConfigProvider>;
  defaultModel?: ConfigModel;
  error?: string;
  source?: string;
}> {
  const cwd = options?.cwd ?? process.cwd();
  const xdgConfigHome = options?.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const homeDir = options?.homeDir ?? os.homedir();

  const harnessHome = options?.harnessHome ?? resolveHarnessPaths().home;

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
      const parsed = JSON.parse(raw) as Config;
      const config = expandEnvVars(parsed) as Config;

      const providers = config.providers ?? DEFAULT_PROVIDERS;
      const models = config.models && Array.isArray(config.models)
        ? mergeProviderDefaults(config.models, providers)
        : [];

      if (models.length === 0) {
        return {
          models: DEFAULT_MODELS,
          providers: DEFAULT_PROVIDERS,
          error: "Config has no models, using default",
          source: candidate.source,
        };
      }

      const defaultModel = config.defaultModel
        ? mergeProviderDefaults([config.defaultModel], providers)[0]
        : undefined;

      return { models, providers, defaultModel, source: candidate.source };
    } catch {
      // try next candidate
    }
  }

  return {
    models: DEFAULT_MODELS,
    providers: DEFAULT_PROVIDERS,
    error: "No config found, using default model",
  };
}
