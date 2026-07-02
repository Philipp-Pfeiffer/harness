import { describe, it, expect, vi, afterEach } from "vitest";
import { createWebFetchTool } from "../../src/tools/web_fetch.js";

function makeFetchResponse(overrides: Partial<Response> & { body?: ReadableStream<Uint8Array> }): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    body: undefined,
    ...overrides,
  } as Response;
}

function stringToStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("web_fetch tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps fetched content in web_content tag", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ body: stringToStream("<html><body><p>Hello world</p></body></html>") })
    );

    const tool = createWebFetchTool(undefined);
    const result = await tool.execute({ url: "https://example.com/" });

    expect(result).toContain('<web_content url="https://example.com/" untrusted="true">');
    expect(result).toContain("Hello world");
    expect(result).toContain("</web_content>");
  });

  it("paginates via line_start", async () => {
    const text = Array.from({ length: 2_000 }, (_, i) => `Line ${i + 1}`).join("\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({
        headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
        body: stringToStream(text),
      })
    );

    const tool = createWebFetchTool(undefined);
    const first = await tool.execute({ url: "https://example.com/" });
    expect(first).toContain("--- Lines 1-");

    const match = first.match(/--- Lines 1-(\d+) of (\d+) ---/);
    expect(match).toBeTruthy();
    const endLine = parseInt(match![1], 10);
    const total = parseInt(match![2], 10);
    expect(endLine).toBeGreaterThan(1);
    expect(endLine).toBeLessThan(total);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({
        headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
        body: stringToStream(text),
      })
    );
    const second = await tool.execute({ url: "https://example.com/", line_start: endLine + 1 });
    expect(second).toMatch(/--- Lines \d+-\d+ of \d+ ---/);
    expect(second).not.toContain("\nLine 1\n");
  });

  it("never exceeds output cap", async () => {
    const longText = "<p>" + "word ".repeat(10_000) + "</p>";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeFetchResponse({ body: stringToStream(longText) }));

    const tool = createWebFetchTool(undefined);
    const result = await tool.execute({ url: "https://example.com/" });
    const content = result.replace(/<web_content[^>]*>/, "").replace("</web_content>", "");
    expect(content.length).toBeLessThanOrEqual(6_500);
  });

  it("blocks private URLs", async () => {
    const tool = createWebFetchTool(undefined);
    const result = await tool.execute({ url: "http://127.0.0.1/secret" });
    expect(result).toContain('<web_content url="http://127.0.0.1/secret" untrusted="true">');
    expect(result).toContain("web_fetch failed");
    expect(result).toContain("127.0.0.1");
  });

  it("blocks redirects to private IP", async () => {
    const redirectResponse = makeFetchResponse({
      ok: false,
      status: 302,
      statusText: "Found",
      headers: new Headers({ location: "http://127.0.0.1/secret" }),
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(redirectResponse);

    const tool = createWebFetchTool(undefined);
    const result = await tool.execute({ url: "https://example.com/redirect" });
    expect(result).toContain("web_fetch failed");
    expect(result).toContain("127.0.0.1");
  });

  it("returns error inside wrapper when line_start is out of range", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ body: stringToStream("<p>One</p>") })
    );

    const tool = createWebFetchTool(undefined);
    const result = await tool.execute({ url: "https://example.com/", line_start: 100 });
    expect(result).toContain("line_start out of range");
    expect(result).toContain("</web_content>");
  });
});
