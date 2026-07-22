/**
 * Voice Transcription via AssemblyAI.
 *
 * Transcribes push-to-talk voice messages using the AssemblyAI API.
 * API key is read from process.env.ASSEMBLYAI_API_KEY — never hardcoded.
 * If the key is missing or transcription fails, returns null.
 */

import { readFile } from "node:fs/promises";

const ASSEMBLYAI_API_KEY = () => process.env.ASSEMBLYAI_API_KEY ?? "";
const UPLOAD_URL = "https://api.assemblyai.com/v2/upload";
const TRANSCRIPT_URL = "https://api.assemblyai.com/v2/transcript";

/**
 * Transcribes an audio file via AssemblyAI.
 * Returns the transcript text, or null if the API key is missing or transcription fails.
 *
 * @param filePath Local path to the audio file.
 * @returns Transcript text or null.
 */
export async function transcribeVoice(filePath: string): Promise<string | null> {
  const apiKey = ASSEMBLYAI_API_KEY();
  if (!apiKey) {
    return null;
  }

  try {
    // Step 1: Upload audio file
    const audioData = await readFile(filePath);
    const uploadResponse = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/octet-stream",
      },
      body: audioData,
    });

    if (!uploadResponse.ok) {
      return null;
    }

    const uploadResult = (await uploadResponse.json()) as { upload_url?: string };
    if (!uploadResult.upload_url) {
      return null;
    }

    // Step 2: Submit transcription request
    const transcriptResponse = await fetch(TRANSCRIPT_URL, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ audio_url: uploadResult.upload_url }),
    });

    if (!transcriptResponse.ok) {
      return null;
    }

    const transcriptResult = (await transcriptResponse.json()) as { id?: string };
    if (!transcriptResult.id) {
      return null;
    }

    // Step 3: Poll for completion
    const transcriptId = transcriptResult.id;
    const pollUrl = `${TRANSCRIPT_URL}/${transcriptId}`;

    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(3000);

      const pollResponse = await fetch(pollUrl, {
        headers: { Authorization: apiKey },
      });

      if (!pollResponse.ok) continue;

      const pollResult = (await pollResponse.json()) as {
        status: string;
        text?: string;
        error?: string;
      };

      if (pollResult.status === "completed") {
        return pollResult.text ?? null;
      }

      if (pollResult.status === "error") {
        return null;
      }
      // status === "processing" or "queued" → keep polling
    }

    // Timeout after ~3 minutes
    return null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
