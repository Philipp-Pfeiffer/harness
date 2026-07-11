import type { SearchHit, SearchOptions, SearchProvider } from "../types.js";
import { SearchProviderError } from "../types.js";

export interface BraveConfig {
  apiKey: string;
  name?: string;
}

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveResult[];
  };
}

export function createBraveProvider(config: BraveConfig): SearchProvider {
  return {
    name: config.name ?? "brave",
    async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(opts.k, 20)));

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": config.apiKey,
          },
        });
      } catch (err) {
        throw new SearchProviderError(`Brave request failed: ${err instanceof Error ? err.message : String(err)}`, err);
      }

      if (response.status === 429) {
        throw new SearchProviderError("Brave rate limit exceeded (429)");
      }
      if (response.status === 403) {
        throw new SearchProviderError("Brave quota/key error (403)");
      }
      if (!response.ok) {
        throw new SearchProviderError(`Brave returned ${response.status} ${response.statusText}`);
      }

      let data: BraveResponse;
      try {
        data = (await response.json()) as BraveResponse;
      } catch (err) {
        throw new SearchProviderError("Brave returned invalid JSON", err);
      }

      const results = data.web?.results ?? [];
      return results
        .filter((r): r is BraveResult & { title: string; url: string } => Boolean(r.title) && Boolean(r.url))
        .slice(0, opts.k)
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description ?? "",
        }));
    },
  };
}
