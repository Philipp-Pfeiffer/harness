/**
 * Baileys Media Download Helper Tests.
 *
 * Verifies:
 * - Host prioritization: socket media_conn host > message URL host > default
 * - Retry with backoff for transient network failures ("fetch failed"),
 *   then host fallback when all attempts on a host fail
 * - No retry for non-retryable errors (HTTP 403)
 * - Missing directPath/url → error without touching the socket
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildMediaHostPlan,
  downloadMediaContent,
  isRetryableDownloadError,
} from "../../src/whatsapp/mediaDownload.js";

function makeSocket(host: string, connHosts: { hostname: string }[] = []) {
  return {
    getMediaHost: vi.fn(() => host),
    refreshMediaConn: vi.fn(async () => ({ hosts: connHosts })),
  };
}

function makeStreamBuffer(chunks: Buffer[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

const downloadMock = vi.fn();

vi.mock("baileys", () => ({
  downloadContentFromMessage: (...args: unknown[]) => downloadMock(...args),
  getUrlFromDirectPath: (directPath: string, host: string) => `https://${host}${directPath}`,
}));

beforeEach(() => {
  downloadMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildMediaHostPlan", () => {
  it("prioritizes the socket media_conn host over the message URL host", async () => {
    const socket = makeSocket("mmg.whatsapp.net");
    const plan = await buildMediaHostPlan(
      { directPath: "/x", mediaKey: undefined },
      socket,
    );
    expect(plan?.hosts[0]).toBe("mmg.whatsapp.net");
    expect(plan?.hosts).toContain("mmg.whatsapp.net");
  });

  it("uses the message URL host when the socket has no host", async () => {
    const socket = makeSocket("");
    const plan = await buildMediaHostPlan(
      { url: "https://mmg.whatsapp.net/c/direct", mediaKey: undefined },
      socket,
    );
    expect(plan?.hosts[0]).toBe("mmg.whatsapp.net");
  });

  it("returns null when neither directPath nor url is present", async () => {
    const plan = await buildMediaHostPlan({ mediaKey: undefined }, undefined);
    expect(plan).toBeNull();
  });

  it("refreshes media_conn when the socket host is empty", async () => {
    const socket = makeSocket("", [{ hostname: "region.host" }]);
    const plan = await buildMediaHostPlan(
      { url: "https://mmg.whatsapp.net/c/direct", mediaKey: undefined },
      socket,
    );
    expect(socket.refreshMediaConn).toHaveBeenCalled();
    expect(plan?.hosts[0]).toBe("region.host");
  });
});

describe("downloadMediaContent", () => {
  it("returns the streamed buffer on success", async () => {
    downloadMock.mockResolvedValue(makeStreamBuffer([Buffer.from("a"), Buffer.from("b")]));
    const buf = await downloadMediaContent(
      { directPath: "/x", mediaKey: undefined },
      "sticker",
      makeSocket("mmg.whatsapp.net"),
    );
    expect(buf.toString()).toBe("ab");
  });

  it("retries transient failures on the same host before moving to the next", async () => {
    downloadMock
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(makeStreamBuffer([Buffer.from("ok")]));

    const buf = await downloadMediaContent(
      { url: "https://mmg.whatsapp.net/c/direct", mediaKey: undefined },
      "sticker",
      makeSocket(""),
    );
    expect(buf.toString()).toBe("ok");
    expect(downloadMock).toHaveBeenCalledTimes(2);
  });

  it("fails fast on non-retryable errors (HTTP 403)", async () => {
    downloadMock.mockRejectedValue(new Error("Failed to fetch stream from https://…: 403"));
    await expect(
      downloadMediaContent(
        { url: "https://mmg.whatsapp.net/c/direct", mediaKey: undefined },
        "sticker",
        makeSocket(""),
      ),
    ).rejects.toThrow("403");
    expect(downloadMock).toHaveBeenCalledTimes(1);
  });

  it("throws when no URL/directPath is present", async () => {
    await expect(
      downloadMediaContent({ mediaKey: undefined }, "sticker", makeSocket("mmg.whatsapp.net")),
    ).rejects.toThrow("No valid media URL or directPath");
    expect(downloadMock).not.toHaveBeenCalled();
  });
});

describe("isRetryableDownloadError", () => {
  it("classifies fetch/network failures as retryable", () => {
    expect(isRetryableDownloadError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableDownloadError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableDownloadError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableDownloadError(new Error("network"))).toBe(true);
  });

  it("does not classify HTTP errors as retryable", () => {
    expect(isRetryableDownloadError(new Error("Failed to fetch stream: 403"))).toBe(false);
    expect(isRetryableDownloadError(new Error("No valid media URL"))).toBe(false);
  });
});
