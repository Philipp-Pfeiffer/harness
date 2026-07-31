import { describe, it, expect, vi, afterEach } from "vitest";
import { PlaywrightBrowserEngine } from "../../src/browser/engine.js";
import type { BrowserSessionOptions } from "../../src/browser/types.js";
import type { ObscuraSession } from "../../src/browser/obscura.js";

const sessionOptions: BrowserSessionOptions = {
  cdpUrl: "http://127.0.0.1:9222",
  downloadDir: "/tmp/downloads",
  navigationTimeoutMs: 1_000,
  actionTimeoutMs: 1_000,
  maxTabs: 3,
  snapshotTokenCap: 4_000,
  maxDownloadBytes: 1024,
};

describe("PlaywrightBrowserEngine obscura lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts obscura on connect and stops it on disconnect in obscura mode", async () => {
    const stop = vi.fn(async () => undefined);
    const startObscura = vi.fn(async (): Promise<ObscuraSession> => ({
      proc: { pid: 1 } as ObscuraSession["proc"],
      cdpUrl: "http://127.0.0.1:9777",
      port: 9777,
      stop,
    }));

    const browser = {
      isConnected: () => true,
      contexts: () => [],
      newContext: vi.fn(async () => ({
        pages: () => [],
        newPage: vi.fn(async () => ({
          on: vi.fn(),
          url: () => "about:blank",
        })),
      })),
      close: vi.fn(async () => undefined),
    };

    const connectOverCDP = vi.fn(async () => browser);

    const engine = new PlaywrightBrowserEngine({
      mode: "obscura",
      cdpUrl: "http://127.0.0.1:9222",
      obscuraPath: "obscura",
      obscuraStartupTimeoutMs: 1_000,
    }, sessionOptions, { startObscura });

    const { chromium } = await import("playwright-core");
    vi.spyOn(chromium, "connectOverCDP").mockImplementation(connectOverCDP);

    await engine.connect();
    expect(startObscura).toHaveBeenCalledWith({
      executable: "obscura",
      startupTimeoutMs: 1_000,
    });
    expect(connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:9777", expect.any(Object));

    await engine.disconnect();
    expect(browser.close).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(engine.isConnected()).toBe(false);
  });

  it("does not start obscura in cdp mode", async () => {
    const startObscura = vi.fn();
    const browser = {
      isConnected: () => true,
      contexts: () => [],
      newContext: vi.fn(async () => ({
        pages: () => [],
        newPage: vi.fn(async () => ({
          on: vi.fn(),
          url: () => "about:blank",
        })),
      })),
      close: vi.fn(async () => undefined),
    };

    const { chromium } = await import("playwright-core");
    vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(browser as never);

    const engine = new PlaywrightBrowserEngine({
      mode: "cdp",
      cdpUrl: "http://127.0.0.1:9222",
      obscuraPath: "obscura",
      obscuraStartupTimeoutMs: 1_000,
    }, sessionOptions, { startObscura });

    await engine.connect();
    expect(startObscura).not.toHaveBeenCalled();
    expect(chromium.connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:9222", expect.any(Object));

    await engine.disconnect();
  });
});
