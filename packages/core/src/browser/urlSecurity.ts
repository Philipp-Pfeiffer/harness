import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BrowserUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUrlError";
  }
}

const BLOCKED_SCHEMES = new Set(["file:", "chrome:", "about:", "data:", "javascript:", "blob:"]);

function isPrivateIp(ip: string): boolean {
  const v4 = isIP(ip) === 4;
  const v6 = isIP(ip) === 6;
  if (!v4 && !v6) return false;

  if (v4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 255 || a === 0) return true;
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIp(mapped[1]!);
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "0.0.0.0") return true;
  return false;
}

/**
 * Validates a URL before browser navigation.
 * Blocks dangerous schemes, localhost, and private/internal IPs (SSRF guard).
 */
export async function validateBrowserUrl(rawUrl: string): Promise<{ hostname: string; normalizedUrl: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BrowserUrlError(`Invalid URL: ${rawUrl}`);
  }

  if (BLOCKED_SCHEMES.has(url.protocol)) {
    throw new BrowserUrlError(`Blocked URL scheme: ${url.protocol}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserUrlError(`Unsupported URL scheme: ${url.protocol}. Only http/https allowed.`);
  }

  const hostname = url.hostname.toLowerCase();
  if (isBlockedHostname(hostname)) {
    throw new BrowserUrlError("localhost is blocked");
  }

  const directIp = isIP(hostname);
  if (directIp) {
    if (isPrivateIp(hostname)) {
      throw new BrowserUrlError(`Private IP address is blocked: ${hostname}`);
    }
    return { hostname, normalizedUrl: url.toString() };
  }

  let ips: string[];
  try {
    ips = (await lookup(hostname, { all: true })).map((r) => r.address);
  } catch (err) {
    throw new BrowserUrlError(
      `DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (ips.length === 0) {
    throw new BrowserUrlError(`DNS lookup returned no addresses for ${hostname}`);
  }

  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new BrowserUrlError(`Hostname ${hostname} resolves to private IP ${ip}`);
    }
  }

  return { hostname, normalizedUrl: url.toString() };
}
