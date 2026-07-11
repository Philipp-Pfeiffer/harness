import { Type } from "@sinclair/typebox";
import TurndownService from "turndown";
import type { Tool } from "./types.js";
import type { WebConfig } from "../config.js";
import { validateUrl, WebSecurityError } from "./webSecurity.js";

const WebFetchArgs = Type.Object({
  url: Type.String({ minLength: 1, description: "URL to fetch. Only http/https allowed." }),
  line_start: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed start line for pagination." })),
});

const DEFAULT_OUTPUT_CAP = 6_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_SIZE = 2 * 1024 * 1024; // 2 MB
const DEFAULT_REDIRECT_LIMIT = 5;
const USER_AGENT = "harness-web-fetch/0.0.1";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

turndown.remove(["script", "style", "nav", "footer", "header", "aside"]);

interface FetchResult {
  url: string;
  text: string;
}

async function fetchWithSecurity(
  rawUrl: string,
  webConfig: WebConfig | undefined,
  redirectCount = 0,
): Promise<FetchResult> {
  const timeoutMs = webConfig?.web_fetch?.timeout ?? DEFAULT_TIMEOUT_MS;
  const redirectLimit = webConfig?.web_fetch?.redirectLimit ?? DEFAULT_REDIRECT_LIMIT;
  const maxResponseSize = webConfig?.web_fetch?.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;

  if (redirectCount > redirectLimit) {
    throw new WebSecurityError(`Too many redirects (limit: ${redirectLimit})`);
  }

  await validateUrl(rawUrl, { allowlist: webConfig?.web_fetch?.allowlist });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(rawUrl, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8",
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new WebSecurityError(`Request timed out after ${timeoutMs}ms`);
    }
    throw new WebSecurityError(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timeoutId);

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) {
      throw new WebSecurityError(`Redirect ${response.status} without Location header`);
    }
    const nextUrl = new URL(location, rawUrl).toString();
    return fetchWithSecurity(nextUrl, webConfig, redirectCount + 1);
  }

  if (!response.ok) {
    throw new WebSecurityError(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");

  const reader = response.body?.getReader();
  if (!reader) {
    throw new WebSecurityError("Response body is not readable");
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalSize += value.length;
        if (totalSize > maxResponseSize) {
          throw new WebSecurityError(`Response exceeds maximum size of ${maxResponseSize} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const charset = parseCharset(contentType) ?? detectCharset(buffer);
  const decoder = new TextDecoder(charset, { fatal: false });
  const rawText = decoder.decode(buffer);

  const text = isHtml ? turndown.turndown(rawText) : rawText;

  return { url: rawUrl, text };
}

function parseCharset(contentType: string): string | undefined {
  const match = contentType.match(/charset=([^;\s]+)/i);
  if (!match) return undefined;
  return match[1]?.replace(/^["']|["']$/g, "");
}

function detectCharset(buffer: Buffer): string {
  const bom = buffer.subarray(0, 3);
  if (bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf) return "utf-8";
  // Simple heuristic: if no null bytes in first 1k, assume utf-8
  const sample = buffer.subarray(0, 1024);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return "latin1";
  }
  return "utf-8";
}

function paginate(text: string, lineStart: number | undefined, cap: number): string {
  const allLines = text.split("\n");
  const start = (lineStart ?? 1) - 1;
  if (start >= allLines.length) {
    return `Error: line_start out of range (content has ${allLines.length} lines)`;
  }

  const lines: string[] = [];
  let used = 0;
  for (let i = start; i < allLines.length; i++) {
    const line = allLines[i];
    const lineSize = Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
    if (used + lineSize > cap) {
      if (lines.length === 0) {
        // First line already exceeds cap: hard-truncate so we never breach it.
        const remaining = cap - used - 1;
        if (remaining > 0) {
          lines.push(line.slice(0, remaining) + "…");
          used += remaining + 1;
        }
      }
      break;
    }
    lines.push(line);
    used += lineSize;
  }

  const total = allLines.length;
  const end = start + lines.length;
  const header = `--- Lines ${start + 1}-${end} of ${total} ---`;
  const nextHint = end < total
    ? `\n[...truncated; use line_start=${end + 1} to continue]`
    : "";
  return `${header}\n${lines.join("\n")}${nextHint}`;
}

export function createWebFetchTool(webConfig: WebConfig | undefined): Tool<typeof WebFetchArgs> {
  const outputCap = webConfig?.web_fetch?.outputCap ?? DEFAULT_OUTPUT_CAP;

  return {
    name: "web_fetch",
    description:
      "Fetch a public web page and return a cleaned text/markdown excerpt. Output is capped and paginated via line_start. Only http/https URLs to public hosts are allowed.",
    parameters: WebFetchArgs,
    async execute(args) {
      try {
        const { text } = await fetchWithSecurity(args.url, webConfig);
        const page = paginate(text, args.line_start, outputCap);
        if (page.startsWith("Error:")) {
          return `<web_content url="${args.url}" untrusted="true">\n${page}\n</web_content>`;
        }
        return `<web_content url="${args.url}" untrusted="true">\n${page}\n</web_content>`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `<web_content url="${args.url}" untrusted="true">\nweb_fetch failed: ${message}\n</web_content>`;
      }
    },
  };
}
