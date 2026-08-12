import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { channelAddendum, channelAddendumAsync } from "../../src/daemon/channelAddendum.js";
import type { SessionOrigin } from "../../src/core/session.js";

const TEST_DIR = join(tmpdir(), `harness-addendum-test-${process.pid}-${Date.now()}`);
const STICKER_DIR = join(TEST_DIR, "stickers");

async function seedLibrary(count: number): Promise<void> {
  await mkdir(STICKER_DIR, { recursive: true });
  const index: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const name = `s${String(i).padStart(3, "0")}`;
    const bytes = Buffer.from(`sticker-${name}`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const datei = `${name}.webp`;
    await writeFile(join(STICKER_DIR, datei), bytes);
    index[hash] = { name, beschreibung: `Beschreibung ${name}`, datei };
  }
  await writeFile(join(STICKER_DIR, "index.json"), JSON.stringify(index));
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("channelAddendum", () => {
  it("returns a non-null string for the whatsapp origin", () => {
    const text = channelAddendum("whatsapp");
    expect(text).toBeTypeOf("string");
    expect((text as string).length).toBeGreaterThan(0);
    // Addendum must be byte-stable (pure function — same input, same output)
    expect(channelAddendum("whatsapp")).toBe(text);
  });

  it.each<SessionOrigin>(["tui", "cron", "api"])(
    "returns undefined for the %s origin (no addendum)",
    (origin) => {
      expect(channelAddendum(origin)).toBeUndefined();
    },
  );
});

describe("channelAddendumAsync (sticker catalog injection)", () => {
  it("injects a catalog when the library has entries", async () => {
    await seedLibrary(2);
    const text = await channelAddendumAsync("whatsapp", STICKER_DIR);
    expect(text).toBeDefined();
    expect(text).toContain("s000 — Beschreibung s000");
    expect(text).toContain("s001 — Beschreibung s001");
    // One line per sticker
    const lines = (text ?? "").split("\n").filter((l) => l.includes(" — "));
    expect(lines).toHaveLength(2);
  });

  it("does not inject a catalog for an empty library", async () => {
    const text = await channelAddendumAsync("whatsapp", STICKER_DIR);
    expect(text).toBeDefined();
    expect(text).not.toContain("Sticker-Katalog");
    expect(text).not.toContain(" — ");
  });

  it("does not inject a catalog for a broken index (no crash)", async () => {
    await mkdir(STICKER_DIR, { recursive: true });
    await writeFile(join(STICKER_DIR, "index.json"), "not-json");
    const text = await channelAddendumAsync("whatsapp", STICKER_DIR);
    expect(text).toBeDefined();
    expect(text).not.toContain("Sticker-Katalog");
  });

  it("caps the catalog at 50 entries", async () => {
    await seedLibrary(60);
    const text = await channelAddendumAsync("whatsapp", STICKER_DIR);
    const lines = (text ?? "").split("\n").filter((l) => l.includes(" — "));
    expect(lines).toHaveLength(50);
  });

  it("returns undefined for non-whatsapp origins", async () => {
    expect(await channelAddendumAsync("tui", STICKER_DIR)).toBeUndefined();
    expect(await channelAddendumAsync("cron", STICKER_DIR)).toBeUndefined();
  });
});
