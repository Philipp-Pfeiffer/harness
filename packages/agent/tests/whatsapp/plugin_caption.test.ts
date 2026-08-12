/**
 * WhatsApp Plugin Media Caption Tests.
 *
 * Verifies that media captions (image/video/document) reach the model as
 * accompanying turn text in parseBaileysMessage:
 * - Image with caption → caption becomes event.text (media annotations
 *   still present)
 * - Image/video/document without caption → text stays empty, behavior
 *   unchanged
 * - Sticker path is not affected (sticker keeps its own annotation, no
 *   caption text)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseBaileysMessage } from "../../src/whatsapp/plugin.js";

vi.mock("baileys", () => ({
  downloadContentFromMessage: vi.fn(async function* () {
    yield Buffer.from("fake-media");
  }),
}));

vi.mock("../../src/whatsapp/media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/whatsapp/media.js")>();
  return {
    ...actual,
    downloadMedia: vi.fn(async (_buffer: Buffer, mimeType: string, type: string, mediaDir: string) => ({
      filePath: join(mediaDir, `${type}.bin`),
      mimeType,
      size: 100,
      type,
    })),
  };
});

vi.mock("../../src/stickers/library.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stickers/library.js")>();
  return {
    ...actual,
    matchOrStoreSticker: vi.fn(async () => ({
      kind: "match",
      record: { name: "pepe", beschreibung: "Der Frosch" },
    })),
  };
});

const TEST_DIR = join(tmpdir(), `harness-caption-test-${process.pid}-${Date.now()}`);
const MEDIA_DIR = join(TEST_DIR, "inbound-media");
const STICKER_DIR = join(TEST_DIR, "stickers");

function createRawMsg() {
  return {
    key: { remoteJid: "491701234567@s.whatsapp.net", id: "test-id" },
    messageTimestamp: Date.now() / 1000,
    pushName: "Test",
    rawJid: "491701234567@s.whatsapp.net",
  };
}

function createOpts() {
  return {
    paths: {
      inboundMedia: MEDIA_DIR,
      whatsapp: join(TEST_DIR, "whatsapp"),
      stickers: STICKER_DIR,
    },
    phoneNumber: "491701234567",
    testMode: false,
    model: null,
    log: vi.fn(),
    callbacks: {},
  };
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(MEDIA_DIR, { recursive: true });
  await mkdir(STICKER_DIR, { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("parseBaileysMessage media captions", () => {
  it("image with caption → caption becomes the turn text", async () => {
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];
    const message = {
      imageMessage: {
        mimetype: "image/jpeg",
        url: "https://example.com/photo.jpg",
        caption: "Schau mal, das ist mein Garten.",
      },
    };

    const event = await parseBaileysMessage(
      message as never,
      "491701234567",
      new Date().toISOString(),
      opts,
      createRawMsg() as never,
    );

    expect(event).not.toBeNull();
    expect(event?.text).toBe("Schau mal, das ist mein Garten.");
    expect(event?.media?.length).toBe(1);
    expect(event?.annotations?.some((a) => a.includes("Bild angehängt"))).toBe(true);
  });

  it("image without caption → text stays empty, annotations unchanged", async () => {
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];
    const message = {
      imageMessage: {
        mimetype: "image/jpeg",
        url: "https://example.com/photo.jpg",
      },
    };

    const event = await parseBaileysMessage(
      message as never,
      "491701234567",
      new Date().toISOString(),
      opts,
      createRawMsg() as never,
    );

    expect(event).not.toBeNull();
    expect(event?.text).toBe("");
    expect(event?.media?.length).toBe(1);
    expect(event?.annotations?.some((a) => a.includes("Bild angehängt"))).toBe(true);
  });

  it("video with caption → caption becomes the turn text", async () => {
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];
    const message = {
      videoMessage: {
        mimetype: "video/mp4",
        url: "https://example.com/video.mp4",
        caption: "Unser Urlaubsvideo",
      },
    };

    const event = await parseBaileysMessage(
      message as never,
      "491701234567",
      new Date().toISOString(),
      opts,
      createRawMsg() as never,
    );

    expect(event).not.toBeNull();
    expect(event?.text).toBe("Unser Urlaubsvideo");
  });

  it("document with caption → caption becomes the turn text", async () => {
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];
    const message = {
      documentMessage: {
        mimetype: "application/pdf",
        url: "https://example.com/doc.pdf",
        fileName: "report.pdf",
        caption: "Bitte prüfen.",
      },
    };

    const event = await parseBaileysMessage(
      message as never,
      "491701234567",
      new Date().toISOString(),
      opts,
      createRawMsg() as never,
    );

    expect(event).not.toBeNull();
    expect(event?.text).toBe("Bitte prüfen.");
  });

  it("sticker path is unaffected — no caption text, own annotation stays", async () => {
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];
    const message = {
      stickerMessage: {
        mimetype: "image/webp",
        url: "https://example.com/sticker.webp",
      },
    };

    const event = await parseBaileysMessage(
      message as never,
      "491701234567",
      new Date().toISOString(),
      opts,
      createRawMsg() as never,
    );

    expect(event).not.toBeNull();
    expect(event?.text).toBe("");
    expect(event?.annotations?.[0]).toBe("[Sticker: pepe — Der Frosch]");
  });
});
