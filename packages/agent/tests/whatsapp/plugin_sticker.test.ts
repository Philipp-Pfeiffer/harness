/**
 * WhatsApp Plugin Sticker Tests.
 *
 * Verifies the sticker inbound path of parseBaileysMessage:
 * - Known sticker (fileSha256 matches library) → annotation with name and
 *   description, no file written to incoming/
 * - Unknown sticker → WebP saved to incoming/<sha256>.webp, annotation
 *   "unbekannt, gespeichert unter <pfad>"
 * - Fallback: when fileSha256 is missing, the downloaded bytes are hashed
 * - Broken/missing index → treated as empty library, no crash
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, readFile, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { parseBaileysMessage } from "../../src/whatsapp/plugin.js";
import { sha256Hex } from "../../src/stickers/library.js";

vi.mock("baileys", () => ({
  downloadContentFromMessage: vi.fn(async function* () {
    yield Buffer.from("fake-sticker-webp");
  }),
}));

vi.mock("../../src/whatsapp/media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/whatsapp/media.js")>();
  return {
    ...actual,
    downloadMedia: vi.fn(async (_buffer: Buffer, mimeType: string, type: string, mediaDir: string) => ({
      filePath: join(mediaDir, "sticker.webp"),
      mimeType,
      size: 100,
      type,
    })),
  };
});

const TEST_DIR = join(tmpdir(), `harness-plugin-sticker-test-${process.pid}-${Date.now()}`);
const MEDIA_DIR = join(TEST_DIR, "inbound-media");
const STICKER_DIR = join(TEST_DIR, "stickers");

const STICKER_BYTES = Buffer.from("fake-sticker-webp");
const KNOWN_HASH = sha256Hex(STICKER_BYTES);

function createStickerMessage(fileSha256?: Buffer): Record<string, unknown> {
  return {
    stickerMessage: {
      mimetype: "image/webp",
      url: "https://example.com/sticker.webp",
      ...(fileSha256 ? { fileSha256 } : {}),
    },
  };
}

function createRawMsg() {
  return {
    key: { remoteJid: "491701234567@s.whatsapp.net", id: "test-id" },
    messageTimestamp: Date.now() / 1000,
    message: createStickerMessage(),
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

async function seedLibrary(): Promise<void> {
  await mkdir(STICKER_DIR, { recursive: true });
  await writeFile(join(STICKER_DIR, "pepe.webp"), STICKER_BYTES);
  await writeFile(
    join(STICKER_DIR, "index.json"),
    JSON.stringify({
      [KNOWN_HASH]: { name: "pepe", beschreibung: "Der Frosch", datei: "pepe.webp" },
    }),
  );
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(MEDIA_DIR, { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("parseBaileysMessage sticker path", () => {
  it("annotates a known sticker with name and description, no incoming file", async () => {
    await seedLibrary();
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];

    const event = await parseBaileysMessage(
      createStickerMessage(Buffer.from(KNOWN_HASH, "hex")) as never,
      "491701234567",
      new Date().toISOString(),
      opts,
      createRawMsg() as never,
    );

    expect(event).not.toBeNull();
    expect(event?.annotations?.[0]).toBe(`[Sticker: pepe — Der Frosch]`);
    // No incoming file for a known sticker
    await expect(access(join(STICKER_DIR, "incoming", `${KNOWN_HASH}.webp`))).rejects.toThrow();
  });

  it("saves an unknown sticker to incoming/ and annotates the saved path", async () => {
    await seedLibrary();
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];

    const unknownHash = createHash("sha256").update(Buffer.from("other-bytes")).digest("hex");
    const event = await parseBaileysMessage(
      createStickerMessage(Buffer.from(unknownHash, "hex")) as never,
      "491701234567",
      new Date().toISOString(),
      opts,
      createRawMsg() as never,
    );

    expect(event).not.toBeNull();
    expect(event?.annotations?.[0]).toContain("[Sticker empfangen: unbekannt");
    expect(event?.annotations?.[0]).toContain(unknownHash);
    const savedPath = join(STICKER_DIR, "incoming", `${unknownHash}.webp`);
    expect(event?.annotations?.[0]).toContain(savedPath);
    const saved = await readFile(savedPath);
    expect(saved.equals(STICKER_BYTES)).toBe(true);
  });

  it("falls back to hashing the downloaded bytes when fileSha256 is missing", async () => {
    await seedLibrary();
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];

    const event = await parseBaileysMessage(
      createStickerMessage(undefined) as never,
      "491701234567",
      new Date().toISOString(),
      opts,
      createRawMsg() as never,
    );

    // Downloaded bytes are "fake-sticker-webp" → hash matches the seeded entry
    expect(event?.annotations?.[0]).toBe(`[Sticker: pepe — Der Frosch]`);
  });

  it("treats a broken index as empty library (unknown, no crash)", async () => {
    await mkdir(STICKER_DIR, { recursive: true });
    await writeFile(join(STICKER_DIR, "index.json"), "not-json");
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];

    const event = await parseBaileysMessage(
      createStickerMessage(Buffer.from(KNOWN_HASH, "hex")) as never,
      "491701234567",
      new Date().toISOString(),
      opts,
      createRawMsg() as never,
    );

    expect(event).not.toBeNull();
    expect(event?.annotations?.[0]).toContain("[Sticker empfangen: unbekannt");
  });
});
