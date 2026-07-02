import type { SearchHit, SearchOptions, SearchProvider } from "../types.js";
import { SearchProviderError } from "../types.js";

export interface SearxngConfig {
  endpoint: string;
  name?: string;
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
}

export function createSearxngProvider(config: SearxngConfig): SearchProvider {
  return {
    name: config.name ?? "searxng",
    async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
      const url = new URL(config.endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
        });
      } catch (err) {
        throw new SearchProviderError(`SearXNG request failed: ${err instanceof Error ? err.message : String(err)}`, err);
      }

      if (!response.ok) {
        throw new SearchProviderError(`SearXNG returned ${response.status} ${response.statusText}`);
      }

      let data: { results?: SearxngResult[] };
      try {
        data = (await response.json()) as { results?: SearxngResult[] };
      } catch (err) {
        throw new SearchProviderError("SearXNG returned invalid JSON", err);
      }

      const results = data.results ?? [];
      return results
        .filter((r): r is SearxngResult & { title: string; url: string } => Boolean(r.title) && Boolean(r.url))
        .slice(0, opts.k)
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content ?? "",
        }));
    },
  };
}
