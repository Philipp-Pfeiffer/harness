import { describe, it, expect } from "vitest";
import { createWebSearchTool } from "../../src/tools/web_search.js";
import { buildSearchProviders, fallbackSearch, applySearchBudgets } from "../../src/tools/webSearch/fallbackSearch.js";
import type { SearchProvider, SearchHit } from "../../src/tools/webSearch/types.js";
import { SearchProviderError } from "../../src/tools/webSearch/types.js";
import type { WebConfig } from "../../src/config.js";

function makeProvider(name: string, behavior: (query: string, opts: { k: number }) => SearchHit[] | Error): SearchProvider {
  return {
    name,
    async search(query, opts) {
      const result = behavior(query, opts);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe("buildSearchProviders", () => {
  it("builds enabled providers in config order", () => {
    const config: WebConfig = {
      web_search: {
        providers: [
          { type: "searxng", endpoint: "https://search.example.com" },
          { type: "brave", apiKey: "brave-key" },
          { type: "tavily", apiKey: "tavily-key" },
        ],
      },
    };
    const providers = buildSearchProviders(config);
    expect(providers.map((p) => p.name)).toEqual(["searxng", "brave", "tavily"]);
  });

  it("skips disabled providers", () => {
    const config: WebConfig = {
      web_search: {
        providers: [
          { type: "brave", apiKey: "brave-key", enabled: false },
          { type: "tavily", apiKey: "tavily-key" },
        ],
      },
    };
    const providers = buildSearchProviders(config);
    expect(providers.map((p) => p.name)).toEqual(["tavily"]);
  });

  it("returns empty list when no providers configured", () => {
    expect(buildSearchProviders(undefined)).toEqual([]);
    expect(buildSearchProviders({})).toEqual([]);
  });

  it("assigns unique default names when multiple providers share the same type", () => {
    const config: WebConfig = {
      web_search: {
        providers: [
          { type: "tavily", apiKey: "key-1" },
          { type: "tavily", apiKey: "key-2" },
          { type: "brave", apiKey: "brave-key" },
        ],
      },
    };
    const providers = buildSearchProviders(config);
    expect(providers.map((p) => p.name)).toEqual(["tavily-1", "tavily-2", "brave"]);
  });

  it("uses explicit names when provided", () => {
    const config: WebConfig = {
      web_search: {
        providers: [
          { type: "tavily", apiKey: "key-1", name: "tavily-primary" },
          { type: "tavily", apiKey: "key-2", name: "tavily-fallback" },
        ],
      },
    };
    const providers = buildSearchProviders(config);
    expect(providers.map((p) => p.name)).toEqual(["tavily-primary", "tavily-fallback"]);
  });
});

describe("fallbackSearch", () => {
  it("uses first provider when it succeeds", async () => {
    const providers = [
      makeProvider("first", () => [{ title: "Hit 1", url: "https://a.test", snippet: "snippet" }]),
      makeProvider("second", () => [{ title: "Hit 2", url: "https://b.test", snippet: "snippet" }]),
    ];
    const result = await fallbackSearch(providers, "query", { k: 5 });
    expect(result.providerName).toBe("first");
    expect(result.hits).toHaveLength(1);
  });

  it("falls back when first provider throws", async () => {
    const providers = [
      makeProvider("first", () => new SearchProviderError("first failed")),
      makeProvider("second", () => [{ title: "Hit 2", url: "https://b.test", snippet: "snippet" }]),
    ];
    const result = await fallbackSearch(providers, "query", { k: 5 });
    expect(result.providerName).toBe("second");
    expect(result.hits).toHaveLength(1);
  });

  it("falls back on 429 error", async () => {
    const providers = [
      makeProvider("first", () => new SearchProviderError("Rate limit exceeded (429)")),
      makeProvider("second", () => [{ title: "Hit 2", url: "https://b.test", snippet: "snippet" }]),
    ];
    const result = await fallbackSearch(providers, "query", { k: 5 });
    expect(result.providerName).toBe("second");
  });

  it("throws when all providers fail", async () => {
    const providers = [
      makeProvider("first", () => new SearchProviderError("first failed")),
      makeProvider("second", () => new SearchProviderError("second failed")),
    ];
    await expect(fallbackSearch(providers, "query", { k: 5 })).rejects.toThrow("All web_search providers failed");
  });

  it("falls back across multiple keys of the same provider type", async () => {
    const providers = [
      makeProvider("tavily-1", () => new SearchProviderError("key 1 quota exceeded")),
      makeProvider("tavily-2", () => [{ title: "Hit", url: "https://example.com", snippet: "snippet" }]),
    ];
    const result = await fallbackSearch(providers, "query", { k: 5 });
    expect(result.providerName).toBe("tavily-2");
    expect(result.hits).toHaveLength(1);
  });

  it("throws when no providers configured", async () => {
    await expect(fallbackSearch([], "query", { k: 5 })).rejects.toThrow("No web_search providers configured");
  });
});

describe("applySearchBudgets", () => {
  it("caps maxResults to configured budget", () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({
      title: `Title ${i}`,
      url: `https://example.com/${i}`,
      snippet: "short",
    }));
    const config: WebConfig = { web_search: { maxResults: 3 } };
    expect(applySearchBudgets(hits, config, 10)).toHaveLength(3);
  });

  it("caps snippet length", () => {
    const hits = [{
      title: "Title",
      url: "https://example.com",
      snippet: "a".repeat(1000),
    }];
    const config: WebConfig = { web_search: { snippetBudget: 50 } };
    const result = applySearchBudgets(hits, config, 10);
    expect(result[0].snippet).toHaveLength(51); // 50 + ellipsis
    expect(result[0].snippet.endsWith("…")).toBe(true);
  });

  it("stops when total budget is exhausted", () => {
    const hits = [
      { title: "A", url: "https://a.test", snippet: "a".repeat(100) },
      { title: "B", url: "https://b.test", snippet: "b".repeat(100) },
      { title: "C", url: "https://c.test", snippet: "c".repeat(100) },
    ];
    const config: WebConfig = { web_search: { totalBudget: 150 } };
    const result = applySearchBudgets(hits, config, 10);
    expect(result.length).toBeLessThan(hits.length);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("createWebSearchTool", () => {
  it("wraps results and errors in web_content tag", async () => {
    const tool = createWebSearchTool(undefined);
    const result = await tool.execute({ query: "test" });
    expect(result).toContain('<web_content url="web_search://test" untrusted="true">');
    expect(result).toContain("web_search failed");
    expect(result).toContain("</web_content>");
  });
});
