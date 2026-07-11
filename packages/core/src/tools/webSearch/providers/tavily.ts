import type { SearchHit, SearchOptions, SearchProvider } from "../types.js";
import { SearchProviderError } from "../types.js";

export interface TavilyConfig {
  apiKey: string;
  name?: string;
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

export function createTavilyProvider(config: TavilyConfig): SearchProvider {
  return {
    name: config.name ?? "tavily",
    async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
      let response: Response;
      try {
        response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            api_key: config.apiKey,
            query,
            max_results: Math.min(opts.k, 20),
            search_depth: "basic",
          }),
        });
      } catch (err) {
        throw new SearchProviderError(`Tavily request failed: ${err instanceof Error ? err.message : String(err)}`, err);
      }

      if (response.status === 429) {
        throw new SearchProviderError("Tavily rate limit exceeded (429)");
      }
      if (response.status === 401 || response.status === 403) {
        throw new SearchProviderError("Tavily quota/key error");
      }
      if (!response.ok) {
        throw new SearchProviderError(`Tavily returned ${response.status} ${response.statusText}`);
      }

      let data: TavilyResponse;
      try {
        data = (await response.json()) as TavilyResponse;
      } catch (err) {
        throw new SearchProviderError("Tavily returned invalid JSON", err);
      }

      const results = data.results ?? [];
      return results
        .filter((r): r is TavilyResult & { title: string; url: string } => Boolean(r.title) && Boolean(r.url))
        .slice(0, opts.k)
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content ?? "",
        }));
    },
  };
}
