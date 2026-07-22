/**
 * WhatsApp Media Pipeline.
 *
 * Downloads media from Baileys message objects, saves to inbound-media/,
 * and returns typed InboundMedia + optional image blocks for vision.
 *
 * Does NOT import Baileys directly — accepts a generic download function
 * callback so tests can mock the Baileys socket.
 */

import { writeFile, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { InboundMedia, InboundImageBlock } from "../daemon/types.js";
import {
  MAX_MEDIA_DOWNLOAD_BYTES,
  MEDIA_FILENAME_RANDOM_CHARS,
} from "./limits.js";

/** Type discriminator for media message types. */
export type MediaMessageType =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "voice";

/** Structured media info extracted from a Baileys message. */
export interface MediaInfo {
  type: MediaMessageType;
  mimeType: string;
  /** Whether this is a push-to-talk voice message. */
  ptt: boolean;
  /** Download function provided by the Baileys socket. */
  download: () => Promise<Buffer>;
  /** Whether the message is a sticker. */
  isSticker: boolean;
}

/**
 * Generates a media filename: YYYY-MM-DD_HH-mm-ss_<4 random chars>.<ext>
 */
export async function generateMediaFilename(mimeType: string, mediaDir: string): Promise<string> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const ext = getMimeTypeExtension(mimeType);

  // Retry loop: if generated filename already exists, regenerate.
  // Prevents collisions when multiple downloads land in the same second.
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const random = randomBytes(MEDIA_FILENAME_RANDOM_CHARS)
      .toString("hex")
      .slice(0, MEDIA_FILENAME_RANDOM_CHARS);
    const filename = `${datePart}_${timePart}_${random}.${ext}`;
    const filePath = join(mediaDir, filename);
    try {
      await access(filePath);
      // File exists — try again
      continue;
    } catch {
      // File does not exist — safe to use
      return filePath;
    }
  }

  // Fallback: append a larger random suffix so we never throw
  const random = randomBytes(8).toString("hex");
  const filename = `${datePart}_${timePart}_${random}.${ext}`;
  return join(mediaDir, filename);
}

/**
 * Maps MIME types to file extensions.
 */
export function getMimeTypeExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/octet-stream": "bin",
    "text/plain": "txt",
  };
  // Strip parameters like "; codecs=opus" for lookup
  const baseMime = mimeType.split(";")[0].trim().toLowerCase();
  return map[baseMime] ?? "bin";
}

/**
 * Downloads media, saves to disk, and returns an InboundMedia object.
 * Enforces the 100MB download cap.
 */
export async function downloadMedia(
  buffer: Buffer,
  mimeType: string,
  type: InboundMedia["type"],
  mediaDir: string,
): Promise<InboundMedia> {
  if (buffer.length > MAX_MEDIA_DOWNLOAD_BYTES) {
    throw new MediaTooLargeError(buffer.length, MAX_MEDIA_DOWNLOAD_BYTES);
  }

  const filePath = await generateMediaFilename(mimeType, mediaDir);
  await writeFile(filePath, buffer);
  const fileStat = await stat(filePath);

  return {
    filePath,
    mimeType,
    size: fileStat.size,
    type,
  };
}

/** Error thrown when media exceeds the download cap. */
export class MediaTooLargeError extends Error {
  readonly actualSize: number;
  readonly maxSize: number;
  constructor(actualSize: number, maxSize: number) {
    super(`Media download size ${actualSize} bytes exceeds maximum ${maxSize} bytes`);
    this.name = "MediaTooLargeError";
    this.actualSize = actualSize;
    this.maxSize = maxSize;
  }
}

/**
 * Checks whether a model supports vision (image content blocks).
 *
 * Priority: explicit `supportsVision` config flag wins over name heuristics.
 * When `supportsVision` is undefined (not configured), falls back to
 * name-based heuristics.
 *
 * @param model Model info with name, provider, and optional supportsVision flag.
 * @returns true if the model can process image content blocks.
 */
export function isVisionCapableModel(
  model: { name: string; provider: string; supportsVision?: boolean },
): boolean {
  // Config flag wins — explicit true or false
  if (model.supportsVision !== undefined) {
    return model.supportsVision;
  }

  // Fallback: name-based heuristics
  const name = model.name.toLowerCase();
  const provider = model.provider.toLowerCase();
  if (provider === "anthropic") return true; // Claude models support vision
  if (provider === "openai" && (name.includes("gpt-4") || name.includes("gpt-4o"))) return true;
  if (provider === "google" || provider === "gemini") return true;
  if (name.includes("vision")) return true;
  if (name.includes("gpt-4")) return true;
  return false;
}

/**
 * Reads an image file into an InboundImageBlock for vision-capable models.
 */
export async function createImageBlock(
  filePath: string,
  mimeType: string,
): Promise<InboundImageBlock> {
  const { readFile } = await import("node:fs/promises");
  const data = await readFile(filePath);
  return { mimeType, data };
}

/**
 * Processes a list of downloaded media, creating image blocks for images
 * when the model is vision-capable.
 *
 * Sticker messages are handled by the caller (log only, no turn).
 */
export async function processMediaForTurn(
  media: InboundMedia[],
  visionCapable: boolean,
): Promise<{ imageBlocks: InboundImageBlock[]; annotations: string[] }> {
  const imageBlocks: InboundImageBlock[] = [];
  const annotations: string[] = [];

  for (const m of media) {
    if (m.type === "image" && visionCapable) {
      try {
        const block = await createImageBlock(m.filePath, m.mimeType);
        imageBlocks.push(block);
      } catch {
        // If reading the image fails, fall back to annotation only
      }
    }

    // Build annotation for all media types
    const sizeStr = formatFileSize(m.size);
    annotations.push(
      `Datei angehängt: ${m.filePath} (${m.type}, ${sizeStr}). Schau sie dir bei Bedarf an.`,
    );
  }

  return { imageBlocks, annotations };
}

/** Formats a byte size as a human-readable string. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
