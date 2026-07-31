import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveSandboxPath,
  verifyDownload,
  writeSandboxFile,
  SandboxError,
} from "../../src/browser/sandbox.js";

describe("download sandbox", () => {
  it("blocks path traversal", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-browser-"));
    expect(() => resolveSandboxPath(dir, "../escape.txt")).toThrow(SandboxError);
  });

  it("writes files with magic-byte verification for PDF", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-browser-"));
    const pdf = Buffer.from("%PDF-1.4 fake content");
    const filePath = await writeSandboxFile(dir, "report.pdf", pdf, 1024 * 1024);
    await verifyDownload(filePath, 1024 * 1024);
    const content = await readFile(filePath);
    expect(content.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("rejects extension/content mismatch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-browser-"));
    const filePath = path.join(dir, "fake.pdf");
    await writeFile(filePath, "not a pdf");
    await expect(verifyDownload(filePath, 1024 * 1024)).rejects.toThrow(SandboxError);
  });
});
