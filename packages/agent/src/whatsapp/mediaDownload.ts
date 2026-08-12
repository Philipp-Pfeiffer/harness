/**
 * Baileys Media Download Helper.
 *
 * Wraps `downloadContentFromMessage` with a robust media host resolution:
 * Baileys' socket fetches a media_conn node on connect (region-optimized
 * host) and exposes it via getMediaHost(). Falling back to the public
 * mmg.whatsapp.net (Baileys' DEF_MEDIA_HOST) can fail for some regions —
 * observed as "fetch failed" on inbound stickers.
 *
 * Also adds a bounded retry with backoff for transient network failures
 * (fetch failed / ECONNRESET / timeouts). Non-network failures (HTTP 4xx,
 * missing URL) are NOT retried.
 */

import {
  downloadContentFromMessage,
  getUrlFromDirectPath,
  type MediaDownloadOptions,
} from "baileys";
import type { DownloadableMessage } from "baileys";
import { sleep } from "../util/async.js";

/** Socket surface we need: media host + media_conn refresh. */
export interface MediaHostSource {
  getMediaHost(): string;
  refreshMediaConn(force?: boolean): Promise<{ hosts: { hostname: string; maxContentLengthBytes: number }[] }>;
}

/** Media host candidates for a download, best first. */
export interface MediaHostPlan {
  hosts: string[];
  /** Whether the first host came from the socket's media_conn (region-optimized). */
  hasSocketHost: boolean;
}

/**
 * Builds the host plan for a media URL: socket media_conn host first, then
 * the host parsed from the message URL, then Baileys' default.
 * Returns null when the message has neither directPath nor url.
 */
export async function buildMediaHostPlan(
  message: DownloadableMessage,
  socket: MediaHostSource | undefined,
): Promise<MediaHostPlan | null> {
  const hosts: string[] = [];
  const pushUnique = (host: string | undefined): void => {
    if (host && !hosts.includes(host)) {
      hosts.push(host);
    }
  };

  let hasSocketHost = false;
  if (socket) {
    let socketHost: string | undefined;
    try {
      socketHost = socket.getMediaHost();
      if (!socketHost) {
        const conn = await socket.refreshMediaConn();
        socketHost = conn.hosts[0]?.hostname;
      }
    } catch {
      socketHost = undefined;
    }
    pushUnique(socketHost);
    hasSocketHost = socketHost !== undefined;
  }

  let messageHost: string | undefined;
  if (message.url) {
    try {
      messageHost = new URL(message.url).host;
    } catch {
      messageHost = undefined;
    }
  }
  pushUnique(messageHost);

  if (!message.directPath && !message.url) {
    return null;
  }
  if (hosts.length === 0) {
    hosts.push("mmg.whatsapp.net");
  }
  return { hosts, hasSocketHost };
}

/** True when the error is a transient network failure worth retrying. */
export function isRetryableDownloadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("UND_ERR_CONNECT_TIMEOUT") ||
    msg.includes("socket hang up") ||
    msg.includes("network")
  );
}

/** Max download attempts per host before moving to the next host. */
export const MAX_DOWNLOAD_ATTEMPTS_PER_HOST = 2;
/** Max media hosts tried before giving up. */
export const MAX_MEDIA_HOSTS = 3;
/** Base backoff between retries (ms). */
export const DOWNLOAD_RETRY_BASE_MS = 250;

/**
 * Downloads and decrypts media content, trying socket/media hosts in order
 * and retrying transient failures. Throws the last error when all hosts
 * and attempts are exhausted.
 */
export async function downloadMediaContent(
  message: DownloadableMessage,
  mediaType: string,
  socket: MediaHostSource | undefined,
): Promise<Buffer> {
  const plan = await buildMediaHostPlan(message, socket);
  if (!plan) {
    throw new Error("No valid media URL or directPath present in message");
  }

  const hosts = plan.hosts.slice(0, MAX_MEDIA_HOSTS);
  const attempts = MAX_DOWNLOAD_ATTEMPTS_PER_HOST;
  let lastErr: unknown = null;

  for (const host of hosts) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const opts: MediaDownloadOptions = {
          host,
          options: { headers: { Origin: "https://web.whatsapp.com" } },
        };
        const stream = await downloadContentFromMessage(message, mediaType as never, opts);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      } catch (err) {
        lastErr = err;
        const retryable = isRetryableDownloadError(err);
        if (retryable && attempt < attempts) {
          await sleep(DOWNLOAD_RETRY_BASE_MS * attempt);
          continue;
        }
        if (retryable && attempt === attempts) {
          break; // next host
        }
        // Non-retryable error (HTTP 4xx, missing URL, …) — fail fast.
        throw err;
      }
    }
  }

  throw lastErr ?? new Error("Media download failed");
}

/** Resolves the direct path to an absolute URL on the given host. */
export function resolveMediaUrl(directPath: string, host: string): string {
  return getUrlFromDirectPath(directPath, host);
}
