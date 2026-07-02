import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.js";
import type { WebConfig } from "../cli/config.js";
import { buildSearchProviders, fallbackSearch, applySearchBudgets } from "./webSearch/fallbackSearch.js";

const WebSearchArgs = Type.Object({
  query: Type.String({ minLength: 1, description: "Search query." }),
  k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5, description: "Maximum number of results." })),
});

function formatHits(query: string, providerName: string, hits: { title: string; url: string; snippet: string }[]): string {
  if (hits.length === 0) {
    return `<web_content url="web_search://${encodeURIComponent(query)}" untrusted="true">\nNo results found (provider: ${providerName}).\n</web_content>`;
  }

  const lines = hits.map((h, i) => `${i + 1}. [${h.title}](${h.url})\n   ${h.snippet}`);
  const body = `provider: ${providerName}\n\n${lines.join("\n\n")}`;
  return `<web_content url="web_search://${encodeURIComponent(query)}" untrusted="true">\n${body}\n</web_content>`;
}

export function createWebSearchTool(webConfig: WebConfig | undefined): Tool<typeof WebSearchArgs> {
  const providers = buildSearchProviders(webConfig);

  return {
    name: "web_search",
    description:
      "Search the web and return a short list of results. Each result contains a title, URL, and snippet. Does not fetch full pages — use web_fetch for that.",
    parameters: WebSearchArgs,
    async execute(args) {
      const k = args.k ?? 5;
      try {
        const { hits, providerName } = await fallbackSearch(providers, args.query, { k });
        const budgeted = applySearchBudgets(hits, webConfig, k);
        return formatHits(args.query, providerName, budgeted);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `<web_content url="web_search://${encodeURIComponent(args.query)}" untrusted="true">\nweb_search failed: ${message}\n</web_content>`;
      }
    },
  };
}
