import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeRestartMarker,
  consumeRestartMarker,
  RESTART_MARKER_FILE,
} from "../../src/daemon/restartMarker.js";

const TEST_DIR = join(tmpdir(), `harness-restart-marker-${process.pid}-${Date.now()}`);

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("restart marker", () => {
  it("writes and consumes a marker round-trip", async () => {
    await writeRestartMarker(TEST_DIR, {
      timestamp: "2026-08-08T10:00:00.000Z",
      reason: "deploy feat/foo",
      replyTarget: "491701234567",
      gitHead: "abc1234",
    });

    const marker = await consumeRestartMarker(TEST_DIR);
    expect(marker).not.toBeNull();
    expect(marker!.reason).toBe("deploy feat/foo");
    expect(marker!.replyTarget).toBe("491701234567");
    expect(marker!.gitHead).toBe("abc1234");

    // Marker is consumed (removed) after reading.
    const again = await consumeRestartMarker(TEST_DIR);
    expect(again).toBeNull();
  });

  it("returns null when no marker exists", async () => {
    expect(await consumeRestartMarker(TEST_DIR)).toBeNull();
  });

  it("round-trips the optional followUp flag", async () => {
    await writeRestartMarker(TEST_DIR, {
      timestamp: "2026-08-08T10:00:00.000Z",
      reason: "config change",
      replyTarget: "491701234567",
      gitHead: "abc1234",
      followUp: true,
    });

    const marker = await consumeRestartMarker(TEST_DIR);
    expect(marker?.followUp).toBe(true);
  });

  it("treats a missing followUp flag as absent (legacy markers)", async () => {
    await writeRestartMarker(TEST_DIR, {
      timestamp: "2026-08-08T10:00:00.000Z",
      reason: "deploy feat/foo",
      replyTarget: "491701234567",
      gitHead: "abc1234",
    });

    const marker = await consumeRestartMarker(TEST_DIR);
    expect(marker?.followUp).toBeUndefined();
  });

  it("consumes and ignores a corrupt marker", async () => {
    await writeFile(join(TEST_DIR, RESTART_MARKER_FILE), "NOT-JSON", "utf-8");
    const marker = await consumeRestartMarker(TEST_DIR);
    expect(marker).toBeNull();
    // The corrupt file is removed so a subsequent boot sees no marker.
    await expect(readFile(join(TEST_DIR, RESTART_MARKER_FILE))).rejects.toThrow();
  });

  it("consumes and ignores a marker with missing fields", async () => {
    await writeFile(
      join(TEST_DIR, RESTART_MARKER_FILE),
      JSON.stringify({ timestamp: "2026-08-08T10:00:00.000Z" }),
      "utf-8",
    );
    const marker = await consumeRestartMarker(TEST_DIR);
    expect(marker).toBeNull();
  });
});
