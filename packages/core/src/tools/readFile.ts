import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { cwd } from "node:process";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Tool, ToolCallContext } from "./types.js";
import { ok, err } from "./types.js";
import { markRead } from "./file_state.js";
import { TEXT_EXTRACT_CAP, BINARY_SCAN_SAMPLE_SIZE } from "./limits.js";

const ReadFileArgs = Type.Object({
  path: Type.String({ description: "Absolute or relative path. Supports ~ for home directory." }),
  lineStart: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed start line, inclusive." })),
  lineEnd: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed end line, inclusive." })),
});

const MAX_EXTRACTED_BYTES = TEXT_EXTRACT_CAP;

function expandTilde(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    return path.replace(/^~/, homedir());
  }
  return path;
}

function isPdf(buffer: Buffer): boolean {
  return buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d;
}

const BINARY_SAMPLE_SIZE = BINARY_SCAN_SAMPLE_SIZE;

const MAGIC_NUMBERS: { magic: Buffer; offset: number }[] = [
  { magic: Buffer.from([0x89, 0x50, 0x4E, 0x47]), offset: 0 }, // PNG
  { magic: Buffer.from([0xFF, 0xD8, 0xFF]), offset: 0 },       // JPEG
  { magic: Buffer.from([0x50, 0x4B, 0x03, 0x04]), offset: 0 }, // ZIP
  { magic: Buffer.from([0x7F, 0x45, 0x4C, 0x46]), offset: 0 }, // ELF
  { magic: Buffer.from([0x1F, 0x8B]), offset: 0 },             // gzip
];

function hasMagicNumber(buffer: Buffer): boolean {
  for (const { magic, offset } of MAGIC_NUMBERS) {
    if (buffer.length < offset + magic.length) continue;
    let match = true;
    for (let i = 0; i < magic.length; i++) {
      if (buffer[offset + i] !== magic[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function hasNullByte(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(BINARY_SAMPLE_SIZE, buffer.length));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

function isBinary(buffer: Buffer): boolean {
  return hasNullByte(buffer) || hasMagicNumber(buffer);
}

function sliceLines(text: string, lineStart?: number, lineEnd?: number): string {
  const lines = text.split("\n");
  const total = lines.length;

  if (lineStart !== undefined && lineStart > total) {
    return `Error: lineStart out of range (file has ${total} lines)`;
  }

  if (lineStart !== undefined && lineEnd !== undefined && lineStart > lineEnd) {
    return `Error: lineStart must be <= lineEnd`;
  }

  const start = (lineStart ?? 1) - 1;
  const end = lineEnd ?? total;
  const selected = lines.slice(start, end);

  return selected.join("\n");
}

function checkSize(text: string): string | null {
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes > MAX_EXTRACTED_BYTES) {
    return `Extracted text exceeds 64 KB (${bytes} bytes). Use lineStart/lineEnd to read a range.`;
  }
  return null;
}

function markSessionRead(context: ToolCallContext | undefined, path: string): void {
  if (context?.sessionId) markRead(context.sessionId, path);
}

export const readFileTool: Tool<typeof ReadFileArgs> = {
  name: "readFile",
  description: "Read the contents of a file from the local filesystem. Supports plain UTF-8 text and PDF (text extraction). Returns text content. For large files, use lineStart/lineEnd to read a specific range.",
  parameters: ReadFileArgs,
  async execute(args, context) {
    const expanded = expandTilde(args.path);
    const resolvedPath = resolve(cwd(), expanded);

    let buffer: Buffer;
    try {
      buffer = await readFile(resolvedPath);
    } catch (err_) {
      if (err_ instanceof Error && "code" in err_) {
        switch (err_.code) {
          case "ENOENT":
            return err(`File not found: ${resolvedPath}`);
          case "EACCES":
            return err(`Permission denied: ${resolvedPath}`);
          case "EISDIR":
            return err(`Path is a directory, not a file: ${resolvedPath}`);
        }
      }
      return err(`Error: ${err_ instanceof Error ? err_.message : String(err_)}`);
    }

    if (isPdf(buffer)) {
      try {
        const doc = await getDocument({ data: new Uint8Array(buffer), standardFontDataUrl: undefined as unknown as string }).promise;
        const pageTexts: string[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          pageTexts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
        }
        let text = pageTexts.join("\n");

        if (args.lineStart !== undefined || args.lineEnd !== undefined) {
          text = sliceLines(text, args.lineStart, args.lineEnd);
          if (text.startsWith("Error:")) return err(text);
        }

        const sizeError = checkSize(text);
        if (sizeError) return err(sizeError);

        markSessionRead(context, resolvedPath);
        return ok(`--- PDF, ${doc.numPages} pages ---\n${text}`);
      } catch (err_) {
        return err(`Failed to parse PDF: ${err_ instanceof Error ? err_.message : String(err_)}`);
      }
    }

    if (isBinary(buffer)) {
      return err("Unsupported binary format detected. Only UTF-8 text and PDF are supported.");
    }

    let content: string;
    try {
      content = await readFile(resolvedPath, "utf-8");
    } catch (err_) {
      return err(`Error: ${err_ instanceof Error ? err_.message : String(err_)}`);
    }

    if (args.lineStart !== undefined || args.lineEnd !== undefined) {
      const allLines = content.split("\n");
      const totalLines = allLines.length;
      const clampedEnd = Math.min(args.lineEnd ?? totalLines, totalLines);
      content = sliceLines(content, args.lineStart, clampedEnd);
      if (content.startsWith("Error:")) return err(content);
      const start = args.lineStart ?? 1;
      markSessionRead(context, resolvedPath);
      return ok(`--- Lines ${start}-${clampedEnd} of ${totalLines} ---\n${content}`);
    }

    const sizeError = checkSize(content);
    if (sizeError) return err(sizeError);
    markSessionRead(context, resolvedPath);
    return ok(content);
  },
};