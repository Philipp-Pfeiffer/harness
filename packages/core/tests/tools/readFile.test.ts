import { describe, it, expect } from "vitest";
import { readFileTool } from "../../src/tools/readFile.ts";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { wasRead } from "../../src/tools/file_state.ts";

const fixtures = resolve(process.cwd(), "tests/fixtures");
const sampleTxt = resolve(fixtures, "sample.txt");
const largeTxt = resolve(fixtures, "large.txt");
const binaryBin = resolve(fixtures, "binary.bin");
const samplePdf = resolve(fixtures, "sample.pdf");

describe("readFile tool", () => {
  describe("UTF-8 text files", () => {
    it("reads existing UTF-8 file correctly", async () => {
      const result = await readFileTool.execute({ path: sampleTxt });
      expect(result).toContain("Hello, this is a sample text file.");
      expect(result).toContain("Line 3 here.");
    });

    it("returns error for non-existent file", async () => {
      const result = await readFileTool.execute({ path: "nonexistent.txt" });
      expect(result).toContain("File not found");
    });

    it("returns error for directory path", async () => {
      const result = await readFileTool.execute({ path: "tests/fixtures" });
      expect(result).toContain("Path is a directory, not a file");
    });
  });

  describe("line range support", () => {
    it("lineStart/lineEnd works for single line range", async () => {
      const result = await readFileTool.execute({ path: sampleTxt, lineStart: 2, lineEnd: 2 });
      expect(result).toContain("Line 3 here.");
      expect(result).toContain("--- Lines 2-2 of 5 ---");
    });

    it("lineStart/lineEnd works for range", async () => {
      const result = await readFileTool.execute({ path: sampleTxt, lineStart: 2, lineEnd: 3 });
      expect(result).toContain("Line 3 here.");
      expect(result).toContain("Line 4 there.");
    });

    it("clamps lineEnd > total lines silently", async () => {
      const result = await readFileTool.execute({ path: sampleTxt, lineStart: 1, lineEnd: 999 });
      expect(result).toContain("--- Lines 1-5 of 5 ---");
    });

    it("returns error when lineStart > total lines", async () => {
      const result = await readFileTool.execute({ path: sampleTxt, lineStart: 999, lineEnd: 1000 });
      expect(result).toContain("lineStart out of range");
    });

    it("returns error when lineStart > lineEnd", async () => {
      const result = await readFileTool.execute({ path: sampleTxt, lineStart: 5, lineEnd: 1 });
      expect(result).toContain("lineStart must be <= lineEnd");
    });
  });

  describe("size limit", () => {
    it("returns error for file >64KB without range", async () => {
      const result = await readFileTool.execute({ path: largeTxt });
      expect(result).toContain("Extracted text exceeds 64 KB");
    });

    it("succeeds for file >64KB with range under 64KB", async () => {
      const result = await readFileTool.execute({ path: largeTxt, lineStart: 1, lineEnd: 10 });
      expect(result).not.toContain("Extracted text exceeds 64 KB");
      expect(result).toContain("--- Lines 1-10 of");
    });
  });

  describe("binary detection", () => {
    it("returns error for binary file with null byte", async () => {
      const result = await readFileTool.execute({ path: binaryBin });
      expect(result).toContain("Unsupported binary format");
    });

    it("returns error for binary file with late null byte (after 1024B)", async () => {
      const lateNullBin = resolve(fixtures, "binary-late-null.bin");
      const result = await readFileTool.execute({ path: lateNullBin });
      expect(result).toContain("Unsupported binary format");
    });

    it("returns error for file with PNG magic header", async () => {
      const pngMagicBin = resolve(fixtures, "binary-png-magic.bin");
      const result = await readFileTool.execute({ path: pngMagicBin });
      expect(result).toContain("Unsupported binary format");
    });

    it("returns error for file with ZIP magic header", async () => {
      const zipMagicBin = resolve(fixtures, "binary-zip-magic.bin");
      const result = await readFileTool.execute({ path: zipMagicBin });
      expect(result).toContain("Unsupported binary format");
    });
  });

  describe("PDF support", () => {
    it("reads PDF file and extracts text with page count header", async () => {
      const result = await readFileTool.execute({ path: samplePdf });
      expect(result).toContain("--- PDF, 1 pages ---");
      expect(result).toContain("Hello PDF");
    });

    it("applies line range to PDF text", async () => {
      const result = await readFileTool.execute({ path: samplePdf, lineStart: 1, lineEnd: 1 });
      expect(result).toContain("--- PDF, 1 pages ---");
    });

    it("marks PDF as read so edit does not fail on READ_REQUIRED", async () => {
      await readFileTool.execute({ path: samplePdf }, { sessionId: "pdf-read-session" });
      expect(wasRead("pdf-read-session", samplePdf)).toBe(true);
      expect(wasRead("other-session", samplePdf)).toBe(false);
    });
  });

  describe("tilde expansion", () => {
    it("expands ~ to homedir", async () => {
      const result = await readFileTool.execute({ path: "~/this-file-does-not-exist-but-tilde-expanded.txt" });
      expect(result).toContain(homedir());
      expect(result).toContain("File not found");
    });
  });
});