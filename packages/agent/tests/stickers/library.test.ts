/**
 * Sticker Library Tests.
 *
 * Verifies:
 * - index.json loading: missing / broken / valid
 * - sha256 matching: hit (annotation with meaning) / miss (file lands in
 *   incoming/, annotation "unbekannt")
 * - catalog: cap at 50, empty library
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  loadStickerIndex,
  sha256Hex,
  matchOrStoreSticker,
  addSticker,
  resolveStickerPath,
  listStickerNames,
  buildStickerCatalog,
  MAX_CATALOG_ENTRIES,
} from "../../src/stickers/library.js";

const TEST_DIR = join(tmpdir(), `harness-stickers-test-${process.pid}-${Date.now()}`);
const LIB_DIR = join(TEST_DIR, "stickers");

function fakeSticker(seed: string): Buffer {
  return Buffer.from(`webp-${seed}-payload`);
}

async function seedLibrary(): Promise<void> {
  await mkdir(LIB_DIR, { recursive: true });
  const sticker = fakeSticker("pepe");
  const hash = sha256Hex(sticker);
  await writeFile(join(LIB_DIR, "pepe.webp"), sticker);
  await writeFile(
    join(LIB_DIR, "index.json"),
    JSON.stringify({
      [hash]: { name: "pepe", beschreibung: "Der Frosch", datei: "pepe.webp" },
    }),
  );
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("loadStickerIndex", () => {
  it("returns empty index when index.json is missing", async () => {
    const { index, degradedReason } = await loadStickerIndex(LIB_DIR);
    expect(index).toEqual({});
    expect(degradedReason).toBeDefined();
    expect(degradedReason).toContain("missing");
  });

  it("returns empty index when index.json is broken JSON", async () => {
    await mkdir(LIB_DIR, { recursive: true });
    await writeFile(join(LIB_DIR, "index.json"), "{not-json");
    const { index, degradedReason } = await loadStickerIndex(LIB_DIR);
    expect(index).toEqual({});
    expect(degradedReason).toBeDefined();
    expect(degradedReason).toContain("broken");
  });

  it("returns empty index for invalid shape (array)", async () => {
    await mkdir(LIB_DIR, { recursive: true });
    await writeFile(join(LIB_DIR, "index.json"), "[]");
    const { index, degradedReason } = await loadStickerIndex(LIB_DIR);
    expect(index).toEqual({});
    expect(degradedReason).toContain("invalid shape");
  });

  it("loads a valid index and skips malformed or dead entries", async () => {
    await mkdir(LIB_DIR, { recursive: true });
    await writeFile(join(LIB_DIR, "ok.webp"), fakeSticker("ok"));
    const okHash = sha256Hex(fakeSticker("ok"));
    await writeFile(
      join(LIB_DIR, "index.json"),
      JSON.stringify({
        [okHash]: { name: "ok", beschreibung: "Ok", datei: "ok.webp" },
        "deadbeef": { name: "ghost", beschreibung: "Missing file", datei: "ghost.webp" },
        "0000000000000000000000000000000000000000000000000000000000000000": {
          name: "broken",
          beschreibung: "No name fields",
        },
      }),
    );
    const { index, degradedReason } = await loadStickerIndex(LIB_DIR);
    expect(index[okHash]).toEqual({ name: "ok", beschreibung: "Ok", datei: "ok.webp" });
    expect(Object.keys(index)).toHaveLength(1);
    expect(degradedReason).toContain("skipped");
  });
});

describe("matchOrStoreSticker", () => {
  it("returns a match with the record for a known hash", async () => {
    await seedLibrary();
    const sticker = fakeSticker("pepe");
    const hash = sha256Hex(sticker);
    const result = await matchOrStoreSticker(LIB_DIR, hash, sticker);
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.record.name).toBe("pepe");
      expect(result.record.beschreibung).toBe("Der Frosch");
      expect(result.sha256).toBe(hash);
    }
  });

  it("saves an unknown sticker to incoming/ and reports the path", async () => {
    await seedLibrary();
    const sticker = fakeSticker("mystery");
    const hash = sha256Hex(sticker);
    const result = await matchOrStoreSticker(LIB_DIR, hash, sticker);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.sha256).toBe(hash);
      expect(result.savedPath).toContain(`${sep}incoming${sep}${hash}.webp`);
      const saved = await readFile(result.savedPath);
      expect(saved.equals(sticker)).toBe(true);
    }
  });

  it("handles a broken index as empty library (unknown, no crash)", async () => {
    await mkdir(LIB_DIR, { recursive: true });
    await writeFile(join(LIB_DIR, "index.json"), "broken");
    const sticker = fakeSticker("mystery");
    const hash = sha256Hex(sticker);
    const result = await matchOrStoreSticker(LIB_DIR, hash, sticker);
    expect(result.kind).toBe("unknown");
  });
});

describe("addSticker / resolveStickerPath / listStickerNames", () => {
  it("adds a sticker and resolves it by name", async () => {
    const add = await addSticker(LIB_DIR, fakeSticker("neo"), "neo", "Die Matrix");
    expect(add.ok).toBe(true);
    if (add.ok) {
      expect(add.record.name).toBe("neo");
      const path = await resolveStickerPath(LIB_DIR, "neo");
      expect(path).toBe(join(LIB_DIR, add.record.datei));
      expect(await resolveStickerPath(LIB_DIR, "missing-name")).toBeUndefined();
      expect(await listStickerNames(LIB_DIR)).toEqual(["neo"]);
    }
  });

  it("deduplicates by content hash", async () => {
    const first = await addSticker(LIB_DIR, fakeSticker("dup"), "dup", "Erst");
    const second = await addSticker(LIB_DIR, fakeSticker("dup"), "dup2", "Zweit");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.record.datei).toBe(second.record.datei);
      expect(await listStickerNames(LIB_DIR)).toEqual(["dup"]);
    }
  });

  it("sanitizes an invalid sticker name", async () => {
    const result = await addSticker(LIB_DIR, fakeSticker("x"), "!!!", "Bad name");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.name).not.toContain("!");
      expect(result.record.name.length).toBeGreaterThan(0);
    }
  });
});

describe("buildStickerCatalog", () => {
  it("returns empty string for an empty library", async () => {
    const catalog = await buildStickerCatalog(LIB_DIR);
    expect(catalog).toBe("");
  });

  it("renders one line per sticker, sorted by name", async () => {
    await mkdir(LIB_DIR, { recursive: true });
    const index: Record<string, unknown> = {};
    for (const [name, desc] of [["zebra", "Streifen"], ["alice", "Hut"], ["bob", "Ball"]] as const) {
      const sticker = fakeSticker(name);
      const hash = sha256Hex(sticker);
      const datei = `${name}.webp`;
      await writeFile(join(LIB_DIR, datei), sticker);
      index[hash] = { name, beschreibung: desc, datei };
    }
    await writeFile(join(LIB_DIR, "index.json"), JSON.stringify(index));
    const catalog = await buildStickerCatalog(LIB_DIR);
    const lines = catalog.split("\n").filter((l) => l.includes(" — "));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("alice — Hut");
    expect(lines[1]).toBe("bob — Ball");
    expect(lines[2]).toBe("zebra — Streifen");
  });

  it("caps the catalog at 50 entries", async () => {
    await mkdir(LIB_DIR, { recursive: true });
    const index: Record<string, unknown> = {};
    for (let i = 0; i < MAX_CATALOG_ENTRIES + 10; i++) {
      const name = `s${String(i).padStart(3, "0")}`;
      const sticker = fakeSticker(name);
      const hash = sha256Hex(sticker);
      const datei = `${name}.webp`;
      await writeFile(join(LIB_DIR, datei), sticker);
      index[hash] = { name, beschreibung: `Sticker ${i}`, datei };
    }
    await writeFile(join(LIB_DIR, "index.json"), JSON.stringify(index));
    const catalog = await buildStickerCatalog(LIB_DIR);
    const lines = catalog.split("\n").filter((l) => l.includes(" — "));
    expect(lines).toHaveLength(MAX_CATALOG_ENTRIES);
  });
});
