import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";

export class WebSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSecurityError";
  }
}

export interface WebFetchSecurityConfig {
  allowlist?: string[];
}

/**
 * Lookup function signature compatible with Node's `net`/`tls` connect options.
 */
type ConnectLookup = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

/**
 * Creates a DNS lookup function that validates resolved IPs at connection
 * time, closing the TOCTOU gap between validateUrl() and the actual fetch().
 *
 * When the hostname is already an IP, it is validated directly. Otherwise DNS
 * is resolved and every returned address is checked against the private-IP
 * blocklist (unless the host is on the allowlist). The callback returns the
 * first validated address — the same one undici connects to.
 */
function createSecureLookup(config?: WebFetchSecurityConfig): ConnectLookup {
  return (hostname, opts, callback) => {
    // Direct IP in URL — validate immediately
    const directIp = isIP(hostname);
    if (directIp) {
      if (!isAllowedHost(hostname, config?.allowlist) && isPrivateIp(hostname)) {
        callback(toErrno(`Private IP address is blocked: ${hostname}`), "", 0);
        return;
      }
      callback(null, hostname, directIp);
      return;
    }

    // Hostname — resolve at connection time (single source of truth)
    lookup(hostname, { all: true, family: opts.family })
      .then((addrs) => {
        if (addrs.length === 0) {
          callback(toErrno(`DNS lookup returned no addresses for ${hostname}`), "", 0);
          return;
        }
        if (!isAllowedHost(hostname, config?.allowlist)) {
          for (const addr of addrs) {
            if (isPrivateIp(addr.address)) {
              callback(toErrno(`Hostname ${hostname} resolves to private IP ${addr.address}`), "", 0);
              return;
            }
          }
        }
        callback(null, addrs[0].address, addrs[0].family);
      })
      .catch((err) => {
        callback(toErrno(`DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`), "", 0);
      });
  };
}

function toErrno(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "ESECURITY";
  return err;
}

/**
 * Creates an undici Dispatcher that validates DNS at connection time.
 *
 * Pass the returned dispatcher to `fetch(url, { dispatcher })` to ensure the
 * IP validated during DNS resolution is the same IP that receives the
 * connection — eliminating DNS-rebinding / SSRF TOCTOU.
 */
export function createSecureDispatcher(config?: WebFetchSecurityConfig): Dispatcher {
  return new Agent({
    connect: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lookup: createSecureLookup(config) as any,
    },
  });
}

function isPrivateIp(ip: string): boolean {
  const v4 = isIPv4(ip);
  const v6 = isIPv6(ip);

  if (!v4 && !v6) return false;

  if (v4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true; // treat malformed as blocked
    }
    const [a, b] = parts;
    // localhost
    if (a === 127) return true;
    // link-local
    if (a === 169 && b === 254) return true;
    // private ranges
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // broadcast / reserved
    if (a === 255 || a === 0) return true;
    return false;
  }

  if (v6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — delegate to IPv4 check
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    // fc00::/7 unique local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // fe80::/10 link-local
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
      return true;
    }
    return false;
  }

  return false;
}

function isIPv4(ip: string): boolean {
  return isIP(ip) === 4;
}

function isIPv6(ip: string): boolean {
  return isIP(ip) === 6;
}

function isAllowedHost(hostname: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  return allowlist.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

/**
 * Validates a URL for SSRF safety.
 *
 * - Allows http/https only.
 * - Blocks localhost, private, and link-local IPs.
 * - Blocks hostnames resolving to private IPs (DNS rebinding protection).
 * - Allowlist can override IP checks for specific hosts.
 *
 * Returns the validated hostname and resolved IP addresses.
 */
export async function validateUrl(
  rawUrl: string,
  config?: WebFetchSecurityConfig,
): Promise<{ hostname: string; ips: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebSecurityError(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebSecurityError(`Unsupported URL scheme: ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new WebSecurityError("localhost is blocked");
  }

  // Direct IP in URL
  const directIp = isIP(hostname);
  if (directIp) {
    if (!isAllowedHost(hostname, config?.allowlist) && isPrivateIp(hostname)) {
      throw new WebSecurityError(`Private IP address is blocked: ${hostname}`);
    }
    return { hostname, ips: [hostname] };
  }

  let ips: string[];
  try {
    ips = (await lookup(hostname, { all: true })).map((r) => r.address);
  } catch (err) {
    throw new WebSecurityError(`DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (ips.length === 0) {
    throw new WebSecurityError(`DNS lookup returned no addresses for ${hostname}`);
  }

  if (!isAllowedHost(hostname, config?.allowlist)) {
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        throw new WebSecurityError(`Hostname ${hostname} resolves to private IP ${ip}`);
      }
    }
  }

  return { hostname, ips };
}
