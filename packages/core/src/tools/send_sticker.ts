/**
 * send_sticker Tool — Send a known sticker from the local library to the
 * active channel chat.
 *
 * The library lives under $HARNESS_STATE/stickers/ (index.json mapping
 * sha256 → {name, beschreibung, datei}). The catalog of available names is
 * injected into the system prompt of WhatsApp sessions — see
 * packages/agent/src/daemon/channelAddendum.ts.
 *
 * Requires a channel context with sticker support (channelStickerSender);
 * otherwise the tool returns an error.
 */

import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import type { Tool } from "./types.js";
import { ok, err } from "./types.js";export const SendStickerArgs = Type.Object({
  name: Type.String({ description: "Name of the sticker from the sticker catalog (e.g. \"pepe\")." }),
});

/**
 * Resolves a sticker name against the local library index.
 *
 * Reads <libraryDir>/index.json directly (shape: { sha256: {name,
 * beschreibung, datei} }). Missing or broken index = empty library, never
 * throws. A missing referenced file counts as unknown.
 */
export async function resolveStickerRecord(
  libraryDir: string,
  name: string,
): Promise<{ ok: true; name: string; filePath: string } | { ok: false; error: string }> {
  let loaded: { index: Record<string, { name: string; beschreibung: string; datei: string }> };
  try {
    const raw = await readFile(`${libraryDir}/index.json`, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      loaded = { index: {} };
    } else {
      const index: Record<string, { name: string; beschreibung: string; datei: string }> = {};
      for (const [hash, value] of Object.entries(parsed as Record<string, unknown>)) {
        const record = value as { name?: unknown; beschreibung?: unknown; datei?: unknown };
        if (
          typeof record?.name === "string" &&
          typeof record?.beschreibung === "string" &&
          typeof record?.datei === "string"
        ) {
          index[hash] = { name: record.name, beschreibung: record.beschreibung, datei: record.datei };
        }
      }
      loaded = { index };
    }
  } catch {
    loaded = { index: {} };
  }

  const record = Object.values(loaded.index).find((r) => r.name === name);
  if (record) {
    return { ok: true, name: record.name, filePath: `${libraryDir}/${record.datei}` };
  }

  const available = Object.values(loaded.index)
    .map((r) => r.name)
    .sort()
    .join(", ");
  return {
    ok: false,
    error: available
      ? `Unbekannter Sticker: ${name}. Verfügbare Sticker: ${available}`
      : `Unbekannter Sticker: ${name}. Die Sticker-Library ist leer — es sind keine Sticker verfügbar.`,
  };
}

export const sendStickerTool: Tool<typeof SendStickerArgs> = {
  name: "send_sticker",
  description:
    "Send a sticker from the local sticker library to the active channel chat (WhatsApp). " +
    "Sticker names are listed in the sticker catalog in the system prompt. " +
    "The library lives in ~/.harness/stickers/ (index.json + webp files).",
  parameters: SendStickerArgs,
  conflictKey() {
    return "send_sticker";
  },
  async execute(args, context) {
    const logger = context?.logger;
    if (!context?.channelStickerSender) {
      return err("Sticker werden nur auf WhatsApp unterstützt — kein sendfähiger Channel aktiv.");
    }
    if (!context.sessionId) {
      return err("Keine aktive Session — send_sticker erfordert eine Channel-Session.");
    }

    // The library index lives under the harness state dir; the daemon passes
    // it via the capability callback (the tool itself cannot know the path).
    const libraryDir = context.stickerLibraryDir;
    if (!libraryDir) {
      return err("Kein Sticker-Library-Verzeichnis konfiguriert (stickerLibraryDir fehlt).");
    }

    const resolved = await resolveStickerRecord(libraryDir, args.name);
    if (!resolved.ok) {
      return err(resolved.error);
    }
    logger?.(`[SEND_STICKER] ${resolved.name} (${resolved.filePath})`);

    const result = await context.channelStickerSender(context.sessionId, {
      name: resolved.name,
      filePath: resolved.filePath,
    });

    if (!result.ok) {
      return err(result.error ?? "Sticker konnte nicht gesendet werden.");
    }

    return ok(`Sticker gesendet: ${resolved.name}`);
  },
};

