import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveHarnessPaths } from "./config/paths.js";

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
  /** Enable inline ` simd` tag parsing for providers that embed reasoning
   * in the content stream instead of using `reasoning_content`. */
  inlineThinking?: boolean;
  input?: ("text" | "image")[];
  /** Explicitly mark the model as vision-capable. Wins over name heuristics. */
  supportsVision?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};

export type WebSearchProviderConfig =
  | { type: "searxng"; endpoint: string; name?: string; enabled?: boolean }
  | { type: "brave"; apiKey: string; name?: string; enabled?: boolean }
  | { type: "tavily"; apiKey: string; name?: string; enabled?: boolean };

export type WebConfig = {
  web_search?: {
    providers?: WebSearchProviderConfig[];
    maxResults?: number;
    snippetBudget?: number;
    totalBudget?: number;
  };
  web_fetch?: {
    outputCap?: number;
    timeout?: number;
    maxResponseSize?: number;
    redirectLimit?: number;
    allowlist?: string[];
  };
};

export type BrowserConfig = {
  cdpUrl?: string;
  model?: string;
  maxTurns?: number;
  maxTokens?: number;
  maxTotalTokens?: number;
  snapshotTokenCap?: number;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  maxTabs?: number;
  maxDownloadBytes?: number;
};

export type Config = {
  models?: ConfigModel[];
  providers?: Record<string, ConfigProvider>;
  defaultModel?: ConfigModel;
  browser?: BrowserConfig;
} & WebConfig;

const DEFAULT_MODELS: ConfigModel[] = [
  { provider: "minimax", model: "MiniMax-M2.7", alias: "MiniMax M2.7" },
];

const DEFAULT_PROVIDERS: Record<string, ConfigProvider> = {};

/**
 * Returns true if the value is an environment-variable reference
 * (either `env:VAR_NAME` or contains `${VAR}` substitution),
 * meaning it is NOT stored in plaintext.
 */
function isEnvRef(value: string): boolean {
  return value.startsWith("env:") || value.includes("${");
}

/**
 * Checks whether the raw (pre-resolution) config contains any API keys
 * stored as plaintext literals rather than environment-variable references.
 */
function hasPlaintextApiKeys(config: Config): boolean {
  if (config.providers) {
    for (const provider of Object.values(config.providers)) {
      if (provider.apiKey && !isEnvRef(provider.apiKey)) return true;
    }
  }
  if (config.models) {
    for (const model of config.models) {
      if (model.apiKey && !isEnvRef(model.apiKey)) return true;
    }
  }
  if (config.defaultModel?.apiKey && !isEnvRef(config.defaultModel.apiKey)) {
    return true;
  }
  if (config.web_search?.providers) {
    for (const p of config.web_search.providers) {
      if ("apiKey" in p && p.apiKey && !isEnvRef(p.apiKey)) return true;
    }
  }
  return false;
}

/**
 * Checks whether the given directory is inside a Git repository
 * by looking for a `.git` entry (directory or file for worktrees).
 */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

function resolveConfigString(value: string): string {
  // Explicit env-reference: the entire value must be "env:VAR_NAME".
  const envRef = value.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);
  if (envRef) {
    const name = envRef[1];
    const envValue = process.env[name];
    if (envValue === undefined) {
      throw new Error(`Missing environment variable referenced by config: ${name}`);
    }
    return envValue;
  }

  // Inline ${VAR} substitution (legacy support).
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const envValue = process.env[name];
    if (envValue === undefined) {
      throw new Error(`Missing environment variable: ${name}`);
    }
    return envValue;
  });
}

function resolveConfigValues(value: unknown): unknown {
  if (typeof value === "string") {
    return resolveConfigString(value);
  }

  if (Array.isArray(value)) {
    return value.map(resolveConfigValues);
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = resolveConfigValues(val);
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
  webConfig: WebConfig;
  browserConfig?: BrowserConfig;
  error?: string;
  warning?: string;
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

  const errors: string[] = [];

  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await readFile(candidate.path, "utf-8");
    } catch (err) {
      // File not found → try next candidate (expected for most candidates).
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      // Other read errors (permission denied, etc.) → record and try next.
      errors.push(`${candidate.source} (${candidate.path}): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // File exists — parse and resolve.
    let parsed: Config;
    try {
      parsed = JSON.parse(raw) as Config;
    } catch (err) {
      // Invalid JSON in a config that exists → surface as a visible error.
      return {
        models: DEFAULT_MODELS,
        providers: DEFAULT_PROVIDERS,
        webConfig: {},
        browserConfig: undefined,
        error: `Failed to parse config at ${candidate.path}: ${err instanceof Error ? err.message : String(err)}`,
        source: candidate.source,
      };
    }

    // Check for plaintext API keys in a Git-tracked directory (security warning).
    // Must be done before resolveConfigValues, since afterwards env: references
    // are indistinguishable from literal values.
    let warning: string | undefined;
    if (hasPlaintextApiKeys(parsed) && await isGitRepo(path.dirname(candidate.path))) {
      warning =
        "Config contains plaintext API keys and is in a Git-tracked directory. " +
        "Use env:VAR_NAME references to avoid committing secrets.";
    }

    // resolveConfigValues may throw for missing env-var references — propagate.
    const config = resolveConfigValues(parsed) as Config;

    const providers = config.providers ?? DEFAULT_PROVIDERS;
    const models = config.models && Array.isArray(config.models)
      ? mergeProviderDefaults(config.models, providers)
      : [];

    const webConfig: WebConfig = {
      web_search: config.web_search,
      web_fetch: config.web_fetch,
    };

    const browserConfig = config.browser;

    if (models.length === 0) {
      return {
        models: DEFAULT_MODELS,
        providers: DEFAULT_PROVIDERS,
        webConfig,
        browserConfig,
        error: "Config has no models, using default",
        warning,
        source: candidate.source,
      };
    }

    const defaultModel = config.defaultModel
      ? mergeProviderDefaults([config.defaultModel], providers)[0]
      : undefined;

    return { models, providers, defaultModel, webConfig, browserConfig, warning, source: candidate.source };
  }

  return {
    models: DEFAULT_MODELS,
    providers: DEFAULT_PROVIDERS,
    webConfig: {},
    browserConfig: undefined,
    error: errors.length > 0
      ? `No usable config found. Errors: ${errors.join("; ")}`
      : "No config found, using default model",
  };
}
