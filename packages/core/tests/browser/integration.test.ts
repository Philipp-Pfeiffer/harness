import { describe, it, expect } from "vitest";
import { resolveBrowserConfig, parseModelRef } from "../../src/browser/config.js";

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

  it("inherits defaultModel when browser.model is unset", () => {
    const config = resolveBrowserConfig(undefined, {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      alias: "DeepSeek",
    });
    expect(config.model).toBe("openrouter/deepseek/deepseek-v4-flash");
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
  it("connects to CDP when BROWSER_INTEGRATION=1", async () => {
    if (process.env.BROWSER_INTEGRATION !== "1") {
      return;
    }

    const { chromium } = await import("playwright-core");
    const cdpUrl = process.env.BROWSER_CDP_URL ?? "http://127.0.0.1:9222";
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 5000 });
    expect(browser.isConnected()).toBe(true);
    await browser.close();
  });
});
