/**
 * WhatsApp Plugin Voice Call-Site Tests.
 *
 * Verifies that when transcribeVoice returns { ok: false }, parseBaileysMessage:
 * - logs a warning with reason + detail
 * - puts a machine-readable annotation into the event (which inbound.ts
 *   appends to the turn text, so the model sees the reason)
 * - does not crash and does not add the media file to the event
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseBaileysMessage } from "../../src/whatsapp/plugin.js";
import { transcribeVoice } from "../../src/whatsapp/voice.js";

vi.mock("../../src/whatsapp/voice.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/whatsapp/voice.js")>();
  return {
    ...actual,
    transcribeVoice: vi.fn(),
  };
});

vi.mock("baileys", () => ({
  downloadContentFromMessage: vi.fn(async function* () {
    yield Buffer.from("fake-audio");
  }),
}));

vi.mock("../../src/whatsapp/media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/whatsapp/media.js")>();
  return {
    ...actual,
    downloadMedia: vi.fn(async (_buffer: Buffer, mimeType: string, type: string, mediaDir: string) => ({
      filePath: join(mediaDir, "voice.ogg"),
      mimeType,
      size: 10,
      type,
    })),
  };
});

const TEST_DIR = join(tmpdir(), `harness-plugin-test-${process.pid}-${Date.now()}`);
const MEDIA_DIR = join(TEST_DIR, "inbound-media");

function createAudioMessage(): Record<string, unknown> {
  return {
    audioMessage: {
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
      seconds: 3,
      url: "https://example.com/voice.ogg",
    },
  };
}

function createRawMsg() {
  return {
    key: { remoteJid: "491701234567@s.whatsapp.net", id: "test-id" },
    messageTimestamp: Date.now() / 1000,
    message: createAudioMessage(),
    pushName: "Test",
    rawJid: "491701234567@s.whatsapp.net",
  };
}

function createOpts() {
  return {
    paths: {
      inboundMedia: MEDIA_DIR,
      whatsapp: join(TEST_DIR, "whatsapp"),
    },
    phoneNumber: "491701234567",
    testMode: false,
    model: null,
    log: vi.fn(),
    callbacks: {},
  };
}

async function setupVoiceResult(result: Awaited<ReturnType<typeof transcribeVoice>>): Promise<void> {
  vi.mocked(transcribeVoice).mockResolvedValueOnce(result);
}
beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(MEDIA_DIR, { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("parseBaileysMessage voice call-site", () => {
  it("annotates the event when transcription fails with missing-api-key", async () => {
    await setupVoiceResult({ ok: false, reason: "missing-api-key" });
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];

    const event = await parseBaileysMessage(createAudioMessage() as never, "491701234567", new Date().toISOString(), opts, createRawMsg() as never);

    expect(event).not.toBeNull();
    expect(event?.text).toBe("[Voice-Nachricht]");
    expect(event?.isVoiceTranscript).toBe(false);
    expect(event?.annotations).toBeDefined();
    expect(event?.annotations?.[0]).toContain("could not be transcribed");
    expect(event?.annotations?.[0]).toContain("ASSEMBLYAI_API_KEY");
    // Media file must NOT be added to the event (transcription failed)
    expect(event?.media).toBeUndefined();

    // warn log with reason + detail
    const warnLog = (opts.log as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1] === "warn");
    expect(warnLog).toBeDefined();
    expect(String(warnLog?.[0])).toContain("missing-api-key");
  });

  it("annotates quota/auth failures with a key/quota hint", async () => {
    await setupVoiceResult({ ok: false, reason: "upload-failed", detail: "401" });
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];

    const event = await parseBaileysMessage(createAudioMessage() as never, "491701234567", new Date().toISOString(), opts, createRawMsg() as never);

    expect(event?.annotations?.[0]).toContain("HTTP 401");
    expect(event?.annotations?.[0]).toContain("ASSEMBLYAI_API_KEY");

    const warnLog = (opts.log as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1] === "warn");
    expect(String(warnLog?.[0])).toContain("upload-failed");
    expect(String(warnLog?.[0])).toContain("401");
  });

  it("does not crash when transcription fails with a non-quota error", async () => {
    await setupVoiceResult({ ok: false, reason: "transcription-error", detail: "Account quota exceeded" });
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];

    const event = await parseBaileysMessage(createAudioMessage() as never, "491701234567", new Date().toISOString(), opts, createRawMsg() as never);

    expect(event).not.toBeNull();
    expect(event?.annotations?.[0]).toContain("Account quota exceeded");
  });

  it("keeps existing success behavior (isVoiceTranscript flag)", async () => {
    await setupVoiceResult({ ok: true, text: "Hallo Welt" });
    const opts = createOpts() as Parameters<typeof parseBaileysMessage>[3];

    const event = await parseBaileysMessage(createAudioMessage() as never, "491701234567", new Date().toISOString(), opts, createRawMsg() as never);

    expect(event).not.toBeNull();
    expect(event?.text).toBe("[Voice-Nachricht] Hallo Welt");
    expect(event?.isVoiceTranscript).toBe(true);
    expect(event?.annotations).toBeUndefined();
    expect(event?.media).toBeUndefined();
  });
});
