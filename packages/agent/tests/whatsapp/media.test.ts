/**
 * WhatsApp Media Pipeline Tests.
 *
 * Verifies:
 * - Media naming schema: YYYY-MM-DD_HH-mm-ss_<4 random chars>.<ext>
 * - Collision-freedom (4 random chars)
 * - 100MB download cap is enforced
 * - MIME type → extension mapping
 * - isVisionCapableModel check
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  downloadMedia,
  generateMediaFilename,
  getMimeTypeExtension,
  isVisionCapableModel,
  createImageBlock,
  processMediaForTurn,
  formatFileSize,
  MediaTooLargeError,
} from "../../src/whatsapp/media.js";
import { MAX_MEDIA_DOWNLOAD_BYTES } from "../../src/whatsapp/limits.js";

const TEST_DIR = join(tmpdir(), `harness-media-test-${process.pid}-${Date.now()}`);
const MEDIA_DIR = join(TEST_DIR, "inbound-media");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(MEDIA_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("WhatsApp Media Pipeline", () => {
  describe("generateMediaFilename", () => {
    it("generates filename with correct pattern", async () => {
      const filename = await generateMediaFilename("image/jpeg", MEDIA_DIR);
      const basename = filename.split("/").pop()!;

      // Pattern: YYYY-MM-DD_HH-mm-ss_XXXX.ext
      expect(basename).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-f0-9]{4}\.jpg$/);
    });

    it("generates unique filenames when files already exist (collision-freedom)", async () => {
      const filenames = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const filePath = await generateMediaFilename("image/jpeg", MEDIA_DIR);
        filenames.add(filePath);
        // Write the file so the next iteration must check existence and regenerate
        await writeFile(filePath, "dummy");
      }
      // With existence-check + regenerate, 100 written files must be 100% unique.
      expect(filenames.size).toBe(100);
    });

    it("uses correct extension for different MIME types", async () => {
      const png = await generateMediaFilename("image/png", MEDIA_DIR);
      expect(png).toMatch(/\.png$/);

      const ogg = await generateMediaFilename("audio/ogg", MEDIA_DIR);
      expect(ogg).toMatch(/\.ogg$/);

      const pdf = await generateMediaFilename("application/pdf", MEDIA_DIR);
      expect(pdf).toMatch(/\.pdf$/);
    });

    it("regenerates filename when target already exists", async () => {
      const first = await generateMediaFilename("image/jpeg", MEDIA_DIR);
      await writeFile(first, "dummy");
      const second = await generateMediaFilename("image/jpeg", MEDIA_DIR);
      expect(second).not.toBe(first);
    });
  });

  describe("getMimeTypeExtension", () => {
    it("maps known MIME types", () => {
      expect(getMimeTypeExtension("image/jpeg")).toBe("jpg");
      expect(getMimeTypeExtension("image/png")).toBe("png");
      expect(getMimeTypeExtension("image/webp")).toBe("webp");
      expect(getMimeTypeExtension("audio/ogg")).toBe("ogg");
      expect(getMimeTypeExtension("audio/mpeg")).toBe("mp3");
      expect(getMimeTypeExtension("video/mp4")).toBe("mp4");
      expect(getMimeTypeExtension("application/pdf")).toBe("pdf");
      expect(getMimeTypeExtension("application/zip")).toBe("zip");
    });

    it("falls back to 'bin' for unknown MIME types", () => {
      expect(getMimeTypeExtension("application/x-unknown")).toBe("bin");
    });
  });

  describe("downloadMedia", () => {
    it("saves media to disk and returns InboundMedia", async () => {
      const buffer = Buffer.from("test image data");
      const media = await downloadMedia(buffer, "image/jpeg", "image", MEDIA_DIR);

      expect(media.mimeType).toBe("image/jpeg");
      expect(media.type).toBe("image");
      expect(media.size).toBe(buffer.length);
      expect(media.filePath).toContain("inbound-media");

      // Verify file exists on disk
      const data = await readFile(media.filePath);
      expect(data.equals(buffer)).toBe(true);
    });

    it("throws MediaTooLargeError when exceeding 100MB cap", async () => {
      // Create a buffer that exceeds the cap (101MB)
      // We don't actually allocate 101MB — we mock the size check
      const oversizedBuffer = Buffer.alloc(0);
      // Override the length check by creating a buffer-like object
      const fakeBuffer = {
        length: MAX_MEDIA_DOWNLOAD_BYTES + 1,
      } as Buffer;

      await expect(downloadMedia(fakeBuffer, "image/jpeg", "image", MEDIA_DIR))
        .rejects.toThrow(MediaTooLargeError);
    });
  });

  describe("isVisionCapableModel", () => {
    it("returns true for Anthropic models", () => {
      expect(isVisionCapableModel({ name: "claude-3-opus", provider: "anthropic" })).toBe(true);
    });

    it("returns true for GPT-4 models", () => {
      expect(isVisionCapableModel({ name: "gpt-4o", provider: "openai" })).toBe(true);
      expect(isVisionCapableModel({ name: "gpt-4-turbo", provider: "openai" })).toBe(true);
    });

    it("returns true for Gemini models", () => {
      expect(isVisionCapableModel({ name: "gemini-pro", provider: "google" })).toBe(true);
    });

    it("returns false for non-vision models", () => {
      expect(isVisionCapableModel({ name: "gpt-3.5-turbo", provider: "openai" })).toBe(false);
      expect(isVisionCapableModel({ name: "minimax-m2", provider: "minimax" })).toBe(false);
    });

    it("supportsVision=true overrides name heuristics", () => {
      expect(isVisionCapableModel({ name: "kimi-k2.7-code", provider: "neuralwatt", supportsVision: true })).toBe(true);
      expect(isVisionCapableModel({ name: "minimax-m2", provider: "minimax", supportsVision: true })).toBe(true);
    });

    it("supportsVision=false overrides name heuristics", () => {
      expect(isVisionCapableModel({ name: "claude-3-opus", provider: "anthropic", supportsVision: false })).toBe(false);
      expect(isVisionCapableModel({ name: "gpt-4o", provider: "openai", supportsVision: false })).toBe(false);
    });

    it("falls back to name heuristics when supportsVision is undefined", () => {
      expect(isVisionCapableModel({ name: "claude-3-opus", provider: "anthropic", supportsVision: undefined })).toBe(true);
      expect(isVisionCapableModel({ name: "gpt-3.5-turbo", provider: "openai", supportsVision: undefined })).toBe(false);
    });
  });

  describe("processMediaForTurn", () => {
    it("creates image blocks for vision-capable models", async () => {
      // Create a small test image
      const buffer = Buffer.from("fake-image-data");
      const media = await downloadMedia(buffer, "image/jpeg", "image", MEDIA_DIR);

      const { imageBlocks, annotations } = await processMediaForTurn([media], true);
      expect(imageBlocks.length).toBe(1);
      expect(imageBlocks[0]!.mimeType).toBe("image/jpeg");
      expect(annotations.length).toBe(1);
      expect(annotations[0]).toContain("Datei angehängt:");
      expect(annotations[0]).toContain("image");
    });

    it("does not create image blocks for non-vision models", async () => {
      const buffer = Buffer.from("fake-image-data");
      const media = await downloadMedia(buffer, "image/jpeg", "image", MEDIA_DIR);

      const { imageBlocks, annotations } = await processMediaForTurn([media], false);
      expect(imageBlocks.length).toBe(0);
      expect(annotations.length).toBe(1);
    });

    it("creates annotations for all media types", async () => {
      const buffer = Buffer.from("fake-audio-data");
      const media = await downloadMedia(buffer, "audio/ogg", "audio", MEDIA_DIR);

      const { annotations } = await processMediaForTurn([media], false);
      expect(annotations[0]).toContain("Datei angehängt:");
      expect(annotations[0]).toContain("audio");
    });
  });

  describe("formatFileSize", () => {
    it("formats bytes correctly", () => {
      expect(formatFileSize(100)).toBe("100 B");
      expect(formatFileSize(1024)).toBe("1.0 KB");
      expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    });
  });
});
