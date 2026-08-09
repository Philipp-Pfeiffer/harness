/**
 * Voice Transcription Tests.
 *
 * Verifies:
 * - Missing ASSEMBLYAI_API_KEY → { ok: false, reason: "missing-api-key" }
 * - HTTP 401 on upload → { ok: false, reason: "upload-failed", detail: "401" }
 * - AssemblyAI status:"error" → { ok: false, reason: "transcription-error", detail }
 * - Polling timeout → { ok: false, reason: "timeout" }
 * - Success → { ok: true, text }
 * - No API keys / bodies are logged
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transcribeVoice } from "../../src/whatsapp/voice.js";

const TEST_DIR = join(tmpdir(), `harness-voice-test-${process.pid}-${Date.now()}`);
const AUDIO_FILE = join(TEST_DIR, "voice.ogg");

/** Creates a Response-like object for fetch mocks. */
function jsonResponse(body: unknown, status = 200, ok = status >= 200 && status < 300): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(AUDIO_FILE, "fake-audio-data");
  delete process.env.ASSEMBLYAI_API_KEY;
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(TEST_DIR, { recursive: true, force: true });
  delete process.env.ASSEMBLYAI_API_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs a promise while advancing fake timers, so sleep(3000) resolves quickly. */
async function withTimers<T>(fn: () => Promise<T>): Promise<T> {
  const promise = fn();
  let done = false;
  void promise.finally(() => {
    done = true;
  });
  // Each advance fires pending sleep() timeouts, letting the poll loop proceed.
  for (let i = 0; i < 200 && !done; i++) {
    await vi.advanceTimersByTimeAsync(3000);
  }
  return promise;
}

describe("transcribeVoice", () => {
  it("returns missing-api-key when ASSEMBLYAI_API_KEY is not set", async () => {
    const result = await transcribeVoice(AUDIO_FILE);
    expect(result).toEqual({ ok: false, reason: "missing-api-key" });
  });

  it("returns read-error when the audio file does not exist", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key";
    const result = await transcribeVoice(join(TEST_DIR, "does-not-exist.ogg"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("read-error");
    }
  });

  it("returns upload-failed with HTTP status detail on upload 401", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeVoice(AUDIO_FILE);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("upload-failed");
      expect(result.detail).toBe("401");
    }
  });

  it("returns submit-failed with HTTP status detail on submit error", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ upload_url: "https://example.com/audio.mp3" }))
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeVoice(AUDIO_FILE);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("submit-failed");
      expect(result.detail).toBe("500");
    }
  });

  it("returns transcription-error with the AssemblyAI error field", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ upload_url: "https://example.com/audio.mp3" }))
      .mockResolvedValueOnce(jsonResponse({ id: "transcript-123" }))
      .mockResolvedValue(jsonResponse({ status: "error", error: "Account quota exceeded" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await withTimers(() => transcribeVoice(AUDIO_FILE));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("transcription-error");
      expect(result.detail).toBe("Account quota exceeded");
    }
  });

  it("returns timeout when polling never completes", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ upload_url: "https://example.com/audio.mp3" }))
      .mockResolvedValueOnce(jsonResponse({ id: "transcript-123" }))
      .mockResolvedValue(jsonResponse({ status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await withTimers(() => transcribeVoice(AUDIO_FILE));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
    }
  });

  it("returns the transcript text on success", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ upload_url: "https://example.com/audio.mp3" }))
      .mockResolvedValueOnce(jsonResponse({ id: "transcript-123" }))
      .mockResolvedValue(jsonResponse({ status: "completed", text: "Hallo Welt" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await withTimers(() => transcribeVoice(AUDIO_FILE));

    expect(result).toEqual({ ok: true, text: "Hallo Welt" });
  });
});
