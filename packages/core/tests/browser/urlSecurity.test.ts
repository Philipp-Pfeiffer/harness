import { describe, it, expect } from "vitest";
import { validateBrowserUrl, BrowserUrlError } from "../../src/browser/urlSecurity.js";

describe("validateBrowserUrl", () => {
  it("blocks file:// scheme", async () => {
    await expect(validateBrowserUrl("file:///etc/passwd")).rejects.toThrow(BrowserUrlError);
  });

  it("blocks chrome:// scheme", async () => {
    await expect(validateBrowserUrl("chrome://version")).rejects.toThrow(BrowserUrlError);
  });

  it("blocks about: scheme", async () => {
    await expect(validateBrowserUrl("about:blank")).rejects.toThrow(BrowserUrlError);
  });

  it("blocks data: scheme", async () => {
    await expect(validateBrowserUrl("data:text/html,hello")).rejects.toThrow(BrowserUrlError);
  });

  it("blocks localhost", async () => {
    await expect(validateBrowserUrl("http://localhost/foo")).rejects.toThrow(BrowserUrlError);
  });

  it("blocks 127.0.0.1", async () => {
    await expect(validateBrowserUrl("http://127.0.0.1/foo")).rejects.toThrow(BrowserUrlError);
  });

  it("blocks 10.x private range", async () => {
    await expect(validateBrowserUrl("http://10.0.0.1/foo")).rejects.toThrow(BrowserUrlError);
  });

  it("allows public https URL", async () => {
    const result = await validateBrowserUrl("https://example.com/");
    expect(result.hostname).toBe("example.com");
  });
});
