import { describe, it, expect } from "vitest";
import { resolveBrowserConfig, parseModelRef } from "../../src/browser/config.js";
import { PlaywrightBrowserEngine } from "../../src/browser/engine.js";
import type { BrowserSessionOptions } from "../../src/browser/types.js";

describe("resolveBrowserConfig", () => {
  it("uses env BROWSER_CDP_URL when set", () => {
    const prev = process.env.BROWSER_CDP_URL;
    process.env.BROWSER_CDP_URL = "http://127.0.0.1:9333";
    try {
      const config = resolveBrowserConfig(undefined, {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        alias: "DeepSeek",
      });
      expect(config.cdpUrl).toBe("http://127.0.0.1:9333");
    } finally {
      if (prev === undefined) delete process.env.BROWSER_CDP_URL;
      else process.env.BROWSER_CDP_URL = prev;
    }
  });

  it("defaults launch mode to obscura", () => {
    const config = resolveBrowserConfig(undefined, {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      alias: "DeepSeek",
    });
    expect(config.mode).toBe("obscura");
    expect(config.obscuraPath).toBe("obscura");
  });

  it("respects explicit cdp mode", () => {
    const config = resolveBrowserConfig({ mode: "cdp" }, {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      alias: "DeepSeek",
    });
    expect(config.mode).toBe("cdp");
  });

  it("inherits defaultModel when browser.model is unset", () => {
    const config = resolveBrowserConfig(undefined, {
      provider: "openrouter",
      model: "@preset/deepseek-flash",
      alias: "DeepSeek Flash",
    });
    expect(config.model).toBe("@preset/deepseek-flash");
  });

  it("passes through explicit OpenRouter preset refs", () => {
    const config = resolveBrowserConfig({
      model: "@preset/deepseek-flash",
    });
    expect(config.model).toBe("@preset/deepseek-flash");
  });

  it("throws when no model is configured", () => {
    expect(() => resolveBrowserConfig()).toThrow(/No browser model configured/);
  });

  it("parses model references", () => {
    expect(parseModelRef("openrouter/deepseek/deepseek-v4-flash")).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
    });
  });
});

describe("browser integration", () => {
  const sessionOptions: BrowserSessionOptions = {
    cdpUrl: "http://127.0.0.1:9222",
    downloadDir: "/tmp/downloads",
    navigationTimeoutMs: 5_000,
    actionTimeoutMs: 5_000,
    maxTabs: 3,
    snapshotTokenCap: 4_000,
    maxDownloadBytes: 1024,
  };

  it("spawns and tears down Obscura when BROWSER_INTEGRATION=1", async () => {
    if (process.env.BROWSER_INTEGRATION !== "1") {
      return;
    }

    const engine = new PlaywrightBrowserEngine({
      mode: "obscura",
      cdpUrl: "http://127.0.0.1:9222",
      obscuraPath: process.env.OBSCURA_PATH ?? "obscura",
      obscuraStartupTimeoutMs: 15_000,
    }, sessionOptions);

    await engine.connect();
    expect(engine.isConnected()).toBe(true);
    await engine.navigate("https://example.com");
    expect(engine.getVisitedUrls()).toContain("https://example.com/");
    await engine.disconnect();
    expect(engine.isConnected()).toBe(false);
  });

  it("connects to external CDP when mode is cdp and BROWSER_INTEGRATION=1", async () => {
    if (process.env.BROWSER_INTEGRATION !== "1") {
      return;
    }

    const cdpUrl = process.env.BROWSER_CDP_URL ?? "http://127.0.0.1:9222";
    const engine = new PlaywrightBrowserEngine({
      mode: "cdp",
      cdpUrl,
      obscuraPath: "obscura",
      obscuraStartupTimeoutMs: 15_000,
    }, sessionOptions);

    await engine.connect();
    expect(engine.isConnected()).toBe(true);
    await engine.disconnect();
  });
});
