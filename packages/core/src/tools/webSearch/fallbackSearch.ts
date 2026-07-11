import type { WebConfig } from "../../config.js";
import type { SearchHit, SearchProvider } from "./types.js";
import { SearchProviderError } from "./types.js";
import { createSearxngProvider } from "./providers/searxng.js";
import { createBraveProvider } from "./providers/brave.js";
import { createTavilyProvider } from "./providers/tavily.js";

export interface FallbackSearchOptions {
  k: number;
  logger?: (msg: string) => void;
}

export function buildSearchProviders(webConfig: WebConfig | undefined): SearchProvider[] {
  const providers: SearchProvider[] = [];
  const configs = webConfig?.web_search?.providers ?? [];
  const typeCounts: Record<string, number> = {};

  for (const cfg of configs) {
    if (cfg.enabled === false) continue;

    typeCounts[cfg.type] = (typeCounts[cfg.type] ?? 0) + 1;
    const instanceIndex = typeCounts[cfg.type];
    const typeTotal = configs.filter((c) => c.enabled !== false && c.type === cfg.type).length;
    const defaultName = typeTotal > 1 ? `${cfg.type}-${instanceIndex}` : cfg.type;
    const name = cfg.name ?? defaultName;

    switch (cfg.type) {
      case "searxng":
        providers.push(createSearxngProvider({ endpoint: cfg.endpoint, name }));
        break;
      case "brave":
        providers.push(createBraveProvider({ apiKey: cfg.apiKey, name }));
        break;
      case "tavily":
        providers.push(createTavilyProvider({ apiKey: cfg.apiKey, name }));
        break;
    }
  }

  return providers;
}

export async function fallbackSearch(
  providers: SearchProvider[],
  query: string,
  options: FallbackSearchOptions
): Promise<{ hits: SearchHit[]; providerName: string }> {
  if (providers.length === 0) {
    throw new SearchProviderError("No web_search providers configured.");
  }

  const errors: { provider: string; error: string }[] = [];

  for (const provider of providers) {
    try {
      const hits = await provider.search(query, { k: options.k });
      options.logger?.(`[web_search] provider=${provider.name} hits=${hits.length}`);
      return { hits, providerName: provider.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.logger?.(`[web_search] provider=${provider.name} error=${message}`);
      errors.push({ provider: provider.name, error: message });
    }
  }

  const summary = errors.map((e) => `${e.provider}: ${e.error}`).join("; ");
  throw new SearchProviderError(`All web_search providers failed: ${summary}`);
}

export function applySearchBudgets(
  hits: SearchHit[],
  webConfig: WebConfig | undefined,
  requestedK: number,
): SearchHit[] {
  const maxResults = Math.min(
    requestedK,
    webConfig?.web_search?.maxResults ?? 10,
  );
  const snippetBudget = webConfig?.web_search?.snippetBudget ?? 400;
  const totalBudget = webConfig?.web_search?.totalBudget ?? 6_000;

  let totalUsed = 0;
  const result: SearchHit[] = [];

  for (const hit of hits.slice(0, maxResults)) {
    const snippet = hit.snippet.length > snippetBudget
      ? `${hit.snippet.slice(0, snippetBudget)}…`
      : hit.snippet;

    const entrySize = hit.title.length + hit.url.length + snippet.length + 10;
    if (totalUsed + entrySize > totalBudget && result.length > 0) {
      break;
    }

    result.push({ ...hit, snippet });
    totalUsed += entrySize;
  }

  return result;
}
