import type { ConfigModel, BrowserConfig } from "../config.js";

export type { BrowserConfig };

export const DEFAULT_BROWSER_CDP_URL = "http://127.0.0.1:9222";
export const DEFAULT_BROWSER_MAX_TURNS = 25;
export const DEFAULT_BROWSER_MAX_TOKENS = 4096;
export const DEFAULT_BROWSER_MAX_TOTAL_TOKENS = 80_000;
export const DEFAULT_SNAPSHOT_TOKEN_CAP = 8_000;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_TABS = 5;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export interface ResolvedBrowserConfig {
  cdpUrl: string;
  model: string;
  maxTurns: number;
  maxTokens: number;
  maxTotalTokens: number;
  snapshotTokenCap: number;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  maxTabs: number;
  maxDownloadBytes: number;
}

export function resolveBrowserConfig(
  config?: BrowserConfig,
  defaultModel?: ConfigModel,
): ResolvedBrowserConfig {
  let model: string;
  if (config?.model) {
    model = config.model;
  } else if (defaultModel) {
    model = `${defaultModel.provider}/${defaultModel.model}`;
  } else {
    throw new Error(
      "No browser model configured. Set browser.model or defaultModel in $HARNESS_HOME/config.json.",
    );
  }

  return {
    cdpUrl: config?.cdpUrl ?? process.env.BROWSER_CDP_URL ?? DEFAULT_BROWSER_CDP_URL,
    model,
    maxTurns: config?.maxTurns ?? DEFAULT_BROWSER_MAX_TURNS,
    maxTokens: config?.maxTokens ?? DEFAULT_BROWSER_MAX_TOKENS,
    maxTotalTokens: config?.maxTotalTokens ?? DEFAULT_BROWSER_MAX_TOTAL_TOKENS,
    snapshotTokenCap: config?.snapshotTokenCap ?? DEFAULT_SNAPSHOT_TOKEN_CAP,
    navigationTimeoutMs: config?.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    actionTimeoutMs: config?.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
    maxTabs: config?.maxTabs ?? DEFAULT_MAX_TABS,
    maxDownloadBytes: config?.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES,
  };
}

export function parseModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid browser model reference "${ref}". Expected "provider/model-id".`);
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}
