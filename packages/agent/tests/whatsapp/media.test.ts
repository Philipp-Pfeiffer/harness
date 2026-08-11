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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { MAX_MEDIA_DOWNLOAD_BYTES, MAX_INLINE_IMAGE_BYTES } from "../../src/whatsapp/limits.js";

/**
 * Sharp mock. `mockMetadata` / `mockToBuffer` control per-test behavior;
 * the real pipeline (metadata → resize → jpeg → toBuffer) is exercised
 * against these hooks.
 */
let mockMetadata: () => Promise<{ width?: number; height?: number }> = async () => ({ width: 1, height: 1 });
let mockResizeCalled = false;
let mockToBuffer: () => Promise<Buffer> = async () => Buffer.from("resized");
let mockDecodeError: Error | null = null;
vi.mock("sharp", () => ({
  default: (() => {
    const impl = (() => {});
    return Object.assign(
      () => ({
        metadata: async () => {
          if (mockDecodeError) throw mockDecodeError;
          return mockMetadata();
        },
        resize: () => {
          mockResizeCalled = true;
          return { jpeg: () => ({ toBuffer: async () => mockToBuffer() }) };
        },
      }),
      impl,
    );
  })(),
}));

const TEST_DIR = join(tmpdir(), `harness-media-test-${process.pid}-${Date.now()}`);
const MEDIA_DIR = join(TEST_DIR, "inbound-media");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(MEDIA_DIR, { recursive: true });
  mockMetadata = async () => ({ width: 1, height: 1 });
  mockResizeCalled = false;
  mockToBuffer = async () => Buffer.from("resized");
  mockDecodeError = null;
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
    // Minimal valid 1x1 PNG
    const TINY_PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    it("creates image blocks for vision-capable models", async () => {
      const media = await downloadMedia(TINY_PNG, "image/png", "image", MEDIA_DIR);

      const { imageBlocks, annotations } = await processMediaForTurn([media], true);
      expect(imageBlocks.length).toBe(1);
      expect(imageBlocks[0]!.mimeType).toBe("image/png");
      expect(imageBlocks[0]!.filePath).toBe(media.filePath);
      expect(annotations.length).toBe(1);
      expect(annotations[0]).toContain("Bild angehängt:");
      expect(annotations[0]).toContain(media.filePath);
    });

    it("does not create image blocks for non-vision models", async () => {
      const media = await downloadMedia(TINY_PNG, "image/png", "image", MEDIA_DIR);

      const { imageBlocks, annotations } = await processMediaForTurn([media], false);
      expect(imageBlocks.length).toBe(0);
      expect(annotations.length).toBe(1);
      expect(annotations[0]).toContain("Bild angehängt:");
    });

    it("creates annotations for all media types", async () => {
      const buffer = Buffer.from("fake-audio-data");
      const media = await downloadMedia(buffer, "audio/ogg", "audio", MEDIA_DIR);

      const { annotations } = await processMediaForTurn([media], false);
      expect(annotations[0]).toContain("Datei angehängt:");
      expect(annotations[0]).toContain("audio");
    });
  });

  describe("createImageBlock", () => {
    // Minimal valid 1x1 PNG
    const TINY_PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    it("returns a block with filePath for a decodable image", async () => {
      const media = await downloadMedia(TINY_PNG, "image/png", "image", MEDIA_DIR);
      const block = await createImageBlock(media.filePath, media.mimeType);
      expect(block).not.toBeNull();
      expect(block!.mimeType).toBe("image/png");
      expect(block!.filePath).toBe(media.filePath);
      expect(block!.data.equals(TINY_PNG)).toBe(true);
    });

    it("returns null for non-decodable content", async () => {
      mockDecodeError = new Error("decode failed");
      const media = await downloadMedia(Buffer.from("not-an-image"), "image/jpeg", "image", MEDIA_DIR);
      const block = await createImageBlock(media.filePath, media.mimeType);
      expect(block).toBeNull();
      mockDecodeError = null;
    });

    it("returns null for missing files", async () => {
      const block = await createImageBlock(join(MEDIA_DIR, "missing.png"), "image/png");
      expect(block).toBeNull();
    });

    it("returns null for files exceeding the inline size cap", async () => {
      // 1 byte over the cap → rejected before any decode attempt
      const oversized = Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1);
      const media = await downloadMedia(oversized, "image/jpeg", "image", MEDIA_DIR);
      // downloadMedia enforces MAX_MEDIA_DOWNLOAD_BYTES (100MB), not the 10MB
      // inline cap — write the file directly so the inline cap is exercised.
      await writeFile(media.filePath, oversized);
      const block = await createImageBlock(media.filePath, media.mimeType);
      expect(block).toBeNull();
    });

    it("downscales oversized images to the max dimension", async () => {
      mockMetadata = async () => ({ width: 5000, height: 3000 });
      mockToBuffer = async () => Buffer.from("resized-jpeg");
      mockResizeCalled = false;
      const media = await downloadMedia(TINY_PNG, "image/png", "image", MEDIA_DIR);
      const block = await createImageBlock(media.filePath, media.mimeType);
      expect(block).not.toBeNull();
      expect(block!.mimeType).toBe("image/jpeg");
      expect(mockResizeCalled).toBe(true);
      expect(block!.data.toString()).toBe("resized-jpeg");
    });

    it("keeps small images untouched (no resize)", async () => {
      mockMetadata = async () => ({ width: 800, height: 600 });
      mockResizeCalled = false;
      const media = await downloadMedia(TINY_PNG, "image/png", "image", MEDIA_DIR);
      const block = await createImageBlock(media.filePath, media.mimeType);
      expect(block).not.toBeNull();
      expect(block!.mimeType).toBe("image/png");
      expect(mockResizeCalled).toBe(false);
      expect(block!.data.equals(TINY_PNG)).toBe(true);
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
