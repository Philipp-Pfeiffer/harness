/**
 * Sticker Library — persistent sticker store under $HARNESS_STATE/stickers/.
 *
 * Layout:
 * - index.json: { [sha256]: { name, beschreibung, datei } } — the only source
 *   of truth for known stickers. Missing or broken index.json yields an
 *   empty library, never a crash.
 * - <datei>.webp: the sticker files referenced by the index.
 * - incoming/<sha256>.webp: unknown stickers received from the channel,
 *   stored by content hash.
 *
 * Known stickers are identified by the SHA-256 of their file content
 * (Baileys' fileSha256 on inbound stickers). There is NO automatic
 * classification — naming/describing stickers is the agent's job.
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** A known sticker from the library index. */
export interface StickerRecord {
  /** File name of the sticker inside the library dir (e.g. "pepe.webp"). */
  datei: string;
  /** Short human name used by the send_sticker tool (e.g. "pepe"). */
  name: string;
  /** One-line description of what the sticker shows. */
  beschreibung: string;
}

/** index.json content: sha256 → sticker record. */
export type StickerIndex = Record<string, StickerRecord>;

/** Result of resolving a sticker by content hash. */
export type StickerMatchResult =
  | { kind: "match"; record: StickerRecord; sha256: string }
  | { kind: "unknown"; sha256: string; savedPath: string };

/** Result of loading the library index. */
export interface StickerIndexLoad {
  index: StickerIndex;
  /** Human-readable reason when the index was missing or broken. */
  degradedReason?: string;
}

/**
 * Loads the sticker index from <dir>/index.json.
 * Missing or invalid index.json (JSON parse error, wrong shape) yields an
 * empty index plus a degradedReason — never throws. A record is skipped when
 * it is missing name/beschreibung/datei or the file does not exist next to
 * the index.
 */
export async function loadStickerIndex(dir: string): Promise<StickerIndexLoad> {
  const indexPath = join(dir, "index.json");
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf-8");
  } catch {
    return { index: {}, degradedReason: `index.json missing (${indexPath})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { index: {}, degradedReason: `index.json broken JSON (${indexPath})` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { index: {}, degradedReason: `index.json invalid shape (${indexPath})` };
  }

  const index: StickerIndex = {};
  let skipped = 0;
  for (const [hash, value] of Object.entries(parsed as Record<string, unknown>)) {
    const record = value as Partial<StickerRecord>;
    if (
      typeof record?.name !== "string" ||
      typeof record?.beschreibung !== "string" ||
      typeof record?.datei !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash)
    ) {
      skipped++;
      continue;
    }
    // A referenced file must actually exist — otherwise the record is dead.
    try {
      const fileStat = await stat(join(dir, record.datei));
      if (!fileStat.isFile()) {
        skipped++;
        continue;
      }
    } catch {
      skipped++;
      continue;
    }
    index[hash] = { name: record.name, beschreibung: record.beschreibung, datei: record.datei };
  }

  return { index, degradedReason: skipped > 0 ? `${skipped} skipped entries` : undefined };
}

/** SHA-256 hex digest of the given buffer. */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Resolves an incoming sticker by its SHA-256.
 * Match → the library record. Miss → saves the buffer to
 * <dir>/incoming/<sha256>.webp (idempotent) and returns the saved path.
 */
export async function matchOrStoreSticker(
  dir: string,
  sha256: string,
  buffer: Buffer,
): Promise<StickerMatchResult> {
  const loaded = await loadStickerIndex(dir);
  const record = loaded.index[sha256];
  if (record) {
    return { kind: "match", record, sha256 };
  }

  const incomingDir = join(dir, "incoming");
  await mkdir(incomingDir, { recursive: true });
  const savedPath = join(incomingDir, `${sha256}.webp`);
  await writeFile(savedPath, buffer);
  return { kind: "unknown", sha256, savedPath };
}

/**
 * Saves a buffer as a library sticker and adds it to index.json.
 * Returns the record on success, or an error message string on failure.
 * Used by tooling (agent-driven) to build up the library.
 */
export async function addSticker(
  dir: string,
  buffer: Buffer,
  name: string,
  beschreibung: string,
): Promise<{ ok: true; record: StickerRecord; sha256: string } | { ok: false; error: string }> {
  const loaded = await loadStickerIndex(dir);
  const sha256 = sha256Hex(buffer);

  // Deduplicate by content hash: reuse the existing record if present.
  const existing = loaded.index[sha256];
  if (existing) {
    return { ok: true, record: existing, sha256 };
  }

  const safeName = name.trim().replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  if (!safeName) {
    return { ok: false, error: "Sticker-Name darf nur Buchstaben, Ziffern, - und _ enthalten." };
  }

  await mkdir(dir, { recursive: true });
  const datei = `${safeName}-${sha256.slice(0, 8)}.webp`;
  await writeFile(join(dir, datei), buffer);

  const record: StickerRecord = { name: safeName, beschreibung: beschreibung.trim(), datei };
  const updated: StickerIndex = { ...loaded.index, [sha256]: record };
  await writeFile(join(dir, "index.json"), JSON.stringify(updated, null, 2) + "\n");

  return { ok: true, record, sha256 };
}

/**
 * Copies an existing file into the library as a sticker (webp expected)
 * and registers it in index.json. Returns the record on success.
 */
export async function importStickerFile(
  dir: string,
  sourcePath: string,
  name: string,
  beschreibung: string,
): Promise<{ ok: true; record: StickerRecord; sha256: string } | { ok: false; error: string }> {
  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch {
    return { ok: false, error: `Quelldatei nicht gefunden: ${sourcePath}` };
  }
  if (!sourceStat.isFile()) {
    return { ok: false, error: `Quellpfad ist keine Datei: ${sourcePath}` };
  }

  const buffer = await readFile(sourcePath);
  return addSticker(dir, buffer, name, beschreibung);
}

/**
 * Returns the absolute file path for a sticker name, or undefined when the
 * name is unknown. Used by the send_sticker tool.
 */
export async function resolveStickerPath(dir: string, name: string): Promise<string | undefined> {
  const loaded = await loadStickerIndex(dir);
  for (const record of Object.values(loaded.index)) {
    if (record.name === name) {
      return join(dir, record.datei);
    }
  }
  return undefined;
}

/**
 * Returns the names of all known stickers, sorted by name.
 * Used by the send_sticker tool error path and the catalog injection.
 */
export async function listStickerNames(dir: string): Promise<string[]> {
  const loaded = await loadStickerIndex(dir);
  return Object.values(loaded.index)
    .map((r) => r.name)
    .sort();
}

/** Builds the catalog block (one line per sticker), capped at MAX_CATALOG_ENTRIES. */
export async function buildStickerCatalog(dir: string): Promise<string> {
  const loaded = await loadStickerIndex(dir);
  const entries = Object.values(loaded.index)
    .map((r) => ({ name: r.name, beschreibung: r.beschreibung }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) {
    return "";
  }
  const capped = entries.slice(0, MAX_CATALOG_ENTRIES);
  const lines = capped.map((e) => `${e.name} — ${e.beschreibung}`);
  return `## Sticker-Katalog\n\n${lines.join("\n")}`;
}

/** Max catalog entries injected into the system prompt. */
export const MAX_CATALOG_ENTRIES = 50;

/** Ensures the sticker directory structure exists (library + incoming). */
export async function ensureStickerDirs(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "incoming"), { recursive: true });
}
