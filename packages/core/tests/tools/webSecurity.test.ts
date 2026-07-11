import { describe, it, expect } from "vitest";
import { validateUrl, WebSecurityError } from "../../src/tools/webSecurity.js";

describe("validateUrl", () => {
  it("blocks localhost", async () => {
    await expect(validateUrl("http://localhost/foo")).rejects.toThrow(WebSecurityError);
  });

  it("blocks 127.0.0.1", async () => {
    await expect(validateUrl("http://127.0.0.1/foo")).rejects.toThrow(WebSecurityError);
  });

  it("blocks 10.x.x.x", async () => {
    await expect(validateUrl("http://10.0.0.1/foo")).rejects.toThrow(WebSecurityError);
  });

  it("blocks 172.16.x.x", async () => {
    await expect(validateUrl("http://172.16.0.1/foo")).rejects.toThrow(WebSecurityError);
  });

  it("blocks 192.168.x.x", async () => {
    await expect(validateUrl("http://192.168.1.1/foo")).rejects.toThrow(WebSecurityError);
  });

  it("blocks 169.254.x.x link-local", async () => {
    await expect(validateUrl("http://169.254.1.1/foo")).rejects.toThrow(WebSecurityError);
  });

  it("blocks ::1", async () => {
    await expect(validateUrl("http://[::1]/foo")).rejects.toThrow(WebSecurityError);
  });

  it("blocks file:// scheme", async () => {
    await expect(validateUrl("file:///etc/passwd")).rejects.toThrow(WebSecurityError);
  });

  it("blocks ftp:// scheme", async () => {
    await expect(validateUrl("ftp://example.com/file")).rejects.toThrow(WebSecurityError);
  });

  it("allows public http URL", async () => {
    const result = await validateUrl("http://example.com/");
    expect(result.hostname).toBe("example.com");
    expect(result.ips.length).toBeGreaterThan(0);
  });

  it("allows public https URL", async () => {
    const result = await validateUrl("https://example.com/");
    expect(result.hostname).toBe("example.com");
  });

  it("allowlist overrides private IP block", async () => {
    const result = await validateUrl("http://127.0.0.1/foo", { allowlist: ["127.0.0.1"] });
    expect(result.hostname).toBe("127.0.0.1");
    expect(result.ips).toContain("127.0.0.1");
  });
});
