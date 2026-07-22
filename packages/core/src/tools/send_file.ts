/**
 * send_file Tool — Send a file to the active channel chat.
 *
 * Validates file existence, size cap, and MIME type.
 * Uses the channelFileSender from ToolCallContext to dispatch
 * to the active channel plugin. Returns err() when no channel
 * context is available or the file type is unsupported.
 */

import { Type } from "@sinclair/typebox";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Tool } from "./types.js";
import { ok, err } from "./types.js";

export const SendFileArgs = Type.Object({
  path: Type.String({ description: "Absolute or relative path to the file to send." }),
  caption: Type.Optional(Type.String({ description: "Optional caption to accompany the file." })),
});

/** Max outbound file size (100 MB). */
const MAX_OUTBOUND_FILE_SIZE = 100 * 1024 * 1024;

/** Common file extension → MIME type mapping. */
const EXTENSION_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".3gp": "video/3gpp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".xml": "application/xml",
};

/** Detects MIME type from file extension. Falls back to application/octet-stream. */
export function detectMimeFromExtension(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}

export const sendFileTool: Tool<typeof SendFileArgs> = {
  name: "send_file",
  description:
    "Send a file to the active channel chat (WhatsApp). Validates file existence and size. " +
    "Use this to proactively send images, PDFs, audio, or any file to the user. " +
    "Only works when a channel (e.g. WhatsApp) is connected to the session.",
  parameters: SendFileArgs,
  conflictKey() {
    return "send_file";
  },
  async execute(args, context) {
    const logger = context?.logger;
    const absolutePath = resolve(args.path);

    // Check file existence and size
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      return err(`Datei nicht gefunden: ${absolutePath}`);
    }

    if (!fileStat.isFile()) {
      return err(`Pfad ist keine Datei: ${absolutePath}`);
    }

    if (fileStat.size > MAX_OUTBOUND_FILE_SIZE) {
      return err(
        `Datei zu groß: ${(fileStat.size / 1024 / 1024).toFixed(1)} MB. Maximum ist ${MAX_OUTBOUND_FILE_SIZE / 1024 / 1024} MB.`,
      );
    }

    const mimeType = detectMimeFromExtension(absolutePath);
    logger?.(`[SEND_FILE] ${absolutePath} (${mimeType}, ${fileStat.size} bytes)`);

    // Check for channel context
    if (!context?.channelFileSender) {
      return err("Kein sendfähiger Channel aktiv. Diese Funktion erfordert eine WhatsApp-Session.");
    }

    if (!context.sessionId) {
      return err("Keine aktive Session — send_file erfordert eine Channel-Session.");
    }

    // Dispatch to channel
    const result = await context.channelFileSender(context.sessionId, {
      path: absolutePath,
      mimeType,
      caption: args.caption,
    });

    if (!result.ok) {
      return err(result.error ?? "Datei konnte nicht gesendet werden.");
    }

    return ok(`Datei gesendet: ${absolutePath} (${mimeType}, ${fileStat.size} bytes)`);
  },
};
