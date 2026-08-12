/**
 * send_sticker Tool Tests.
 *
 * Verifies:
 * - Happy path: known sticker name, sender available → ok()
 * - Unknown name → err() with the list of available names
 * - Channel without sticker support → err("Sticker werden nur auf WhatsApp")
 * - No channel context (channelStickerSender missing) → err()
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { sendStickerTool } from "../../src/tools/send_sticker.js";
import type { ToolCallContext } from "../../src/tools/types.js";

const TEST_DIR = join(tmpdir(), `harness-sendsticker-test-${process.pid}-${Date.now()}`);
const LIB_DIR = join(TEST_DIR, "stickers");

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function seedLibrary(names: string[]): Promise<void> {
  await mkdir(LIB_DIR, { recursive: true });
  const index: Record<string, unknown> = {};
  for (const name of names) {
    const buffer = Buffer.from(`sticker-${name}`);
    const hash = sha256(buffer);
    const datei = `${name}.webp`;
    await writeFile(join(LIB_DIR, datei), buffer);
    index[hash] = { name, beschreibung: `Beschreibung ${name}`, datei };
  }
  await writeFile(join(LIB_DIR, "index.json"), JSON.stringify(index));
}

function createContext(overrides?: Partial<ToolCallContext>): ToolCallContext {
  return {
    sessionId: "test-session",
    logger: () => {},
    stickerLibraryDir: LIB_DIR,
    channelStickerSender: async () => ({ ok: true }),
    ...overrides,
  };
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("send_sticker Tool", () => {
  it("returns ok() when the sticker is known and the sender is available", async () => {
    await seedLibrary(["pepe"]);
    const result = await sendStickerTool.execute({ name: "pepe" }, createContext());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Sticker gesendet");
    expect(result.content).toContain("pepe");
  });

  it("passes the resolved file path to the channel sticker sender", async () => {
    await seedLibrary(["pepe"]);
    let captured: { name: string; filePath: string } | undefined;
    const result = await sendStickerTool.execute(
      { name: "pepe" },
      createContext({
        channelStickerSender: async (_sid, sticker) => {
          captured = sticker;
          return { ok: true };
        },
      }),
    );
    expect(result.isError).toBe(false);
    expect(captured?.name).toBe("pepe");
    expect(captured?.filePath).toBe(join(LIB_DIR, "pepe.webp"));
  });

  it("returns err() with the available names for an unknown sticker", async () => {
    await seedLibrary(["pepe", "alice"]);
    const result = await sendStickerTool.execute({ name: "nope" }, createContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unbekannter Sticker: nope");
    expect(result.content).toContain("alice");
    expect(result.content).toContain("pepe");
  });

  it("returns err() with an empty-library hint when no stickers exist", async () => {
    const result = await sendStickerTool.execute({ name: "nope" }, createContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Library ist leer");
  });

  it("returns err() when no channel context (channelStickerSender missing)", async () => {
    await seedLibrary(["pepe"]);
    const result = await sendStickerTool.execute(
      { name: "pepe" },
      createContext({ channelStickerSender: undefined }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Sticker werden nur auf WhatsApp unterstützt");
  });

  it("returns err() when no sessionId", async () => {
    await seedLibrary(["pepe"]);
    const result = await sendStickerTool.execute(
      { name: "pepe" },
      createContext({ sessionId: undefined }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Keine aktive Session");
  });

  it("returns err() when the channel sender fails", async () => {
    await seedLibrary(["pepe"]);
    const result = await sendStickerTool.execute(
      { name: "pepe" },
      createContext({
        channelStickerSender: async () => ({ ok: false, error: "Channel nicht verbunden" }),
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Channel nicht verbunden");
  });
});
