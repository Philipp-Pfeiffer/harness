/**
 * Voice Transcription via AssemblyAI.
 *
 * Transcribes push-to-talk voice messages using the AssemblyAI API.
 * API key is read from process.env.ASSEMBLYAI_API_KEY — never hardcoded.
 * Returns a discriminated result so callers can distinguish failure reasons
 * instead of silently receiving null.
 */

import { readFile } from "node:fs/promises";

const ASSEMBLYAI_API_KEY = () => process.env.ASSEMBLYAI_API_KEY ?? "";
const UPLOAD_URL = "https://api.assemblyai.com/v2/upload";
const TRANSCRIPT_URL = "https://api.assemblyai.com/v2/transcript";

/** Why a voice transcription failed. */
export type VoiceErrorReason =
  | "missing-api-key"
  | "upload-failed"
  | "submit-failed"
  | "transcription-error"
  | "timeout"
  | "read-error";

/** Successful transcription result. */
export interface VoiceTranscriptionOk {
  ok: true;
  text: string;
}

/** Failed transcription result with a machine-readable reason. */
export interface VoiceTranscriptionFailed {
  ok: false;
  reason: VoiceErrorReason;
  /** Additional context, e.g. HTTP status code or the AssemblyAI error message. */
  detail?: string;
}

/** Discriminated result of a voice transcription attempt. */
export type VoiceTranscriptionResult = VoiceTranscriptionOk | VoiceTranscriptionFailed;

/**
 * Options for tuning the AssemblyAI polling loop (tests use small values).
 */
export interface VoiceTranscriptionOptions {
  /** Delay between polling attempts (default: 3000 ms). */
  pollIntervalMs?: number;
  /** Total wall-clock budget for polling (default: 60 * 3000 ms). */
  pollTimeoutMs?: number;
}

/**
 * Transcribes an audio file via AssemblyAI.
 *
 * @param filePath Local path to the audio file.
 * @param options Optional polling tuning; defaults preserve the original 3s / 60-attempt behavior.
 * @returns `{ ok: true, text }` on success, or `{ ok: false, reason, detail? }` on failure.
 */
export async function transcribeVoice(
  filePath: string,
  options: VoiceTranscriptionOptions = {},
): Promise<VoiceTranscriptionResult> {
  const apiKey = ASSEMBLYAI_API_KEY();
  if (!apiKey) {
    return { ok: false, reason: "missing-api-key" };
  }

  // Step 1: Upload audio file
  let audioData: Awaited<ReturnType<typeof readFile>>;
  try {
    audioData = await readFile(filePath);
  } catch (err) {
    return {
      ok: false,
      reason: "read-error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/octet-stream",
      },
      body: audioData,
    });
  } catch (err) {
    return {
      ok: false,
      reason: "upload-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!uploadResponse.ok) {
    return { ok: false, reason: "upload-failed", detail: String(uploadResponse.status) };
  }

  const uploadResult = (await uploadResponse.json()) as { upload_url?: string };
  if (!uploadResult.upload_url) {
    return { ok: false, reason: "upload-failed", detail: "missing upload_url in response" };
  }

  // Step 2: Submit transcription request
  let transcriptResponse: Response;
  try {
    transcriptResponse = await fetch(TRANSCRIPT_URL, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ audio_url: uploadResult.upload_url }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "submit-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!transcriptResponse.ok) {
    return { ok: false, reason: "submit-failed", detail: String(transcriptResponse.status) };
  }

  const transcriptResult = (await transcriptResponse.json()) as { id?: string };
  if (!transcriptResult.id) {
    return { ok: false, reason: "submit-failed", detail: "missing id in response" };
  }

  // Step 3: Poll for completion
  const transcriptId = transcriptResult.id;
  const pollUrl = `${TRANSCRIPT_URL}/${transcriptId}`;
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 60 * 3000;
  const pollStart = Date.now();

  // do-while: always poll at least once, even with a zero/negative timeout budget
  // (matches the old 60-attempt loop at the timeout boundary).
  do {
    await sleep(pollIntervalMs);

    let pollResponse: Response;
    try {
      pollResponse = await fetch(pollUrl, {
        headers: { Authorization: apiKey },
      });
    } catch (err) {
      return {
        ok: false,
        reason: "timeout",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (!pollResponse.ok) continue;

    const pollResult = (await pollResponse.json()) as {
      status: string;
      text?: string;
      error?: string;
    };

    if (pollResult.status === "completed") {
      return { ok: true, text: pollResult.text ?? "" };
    }

    if (pollResult.status === "error") {
      return {
        ok: false,
        reason: "transcription-error",
        detail: pollResult.error,
      };
    }
    // status === "processing" or "queued" → keep polling
  } while (Date.now() - pollStart < pollTimeoutMs);

  // Timeout after ~3 minutes
  return { ok: false, reason: "timeout" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
