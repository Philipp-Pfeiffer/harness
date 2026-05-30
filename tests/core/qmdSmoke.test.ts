import { describe, it, expect, beforeAll } from "vitest";
import { QmdBackend } from "../../src/core/qmdBackend.js";
import { ensureQmdCollections } from "../../src/core/qmdSetup.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";

/**
 * Real QMD smoke test.
 * Skips gracefully if QMD is not installed (e.g. in CI).
 */

let qmdAvailable = false;

beforeAll(async () => {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("qmd", ["--version"], { timeout: 5_000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    qmdAvailable = true;
  } catch {
    qmdAvailable = false;
  }
});

describe("QMD Smoke Test", () => {
  it.skipIf(!qmdAvailable)("end-to-end: write, register, index, and retrieve a markdown file", async () => {
    const testDir = resolve(tmpdir(), `harness-qmd-smoke-${Date.now()}`);
    const memoryPath = resolve(testDir, "memory");
    const sourcesPath = resolve(testDir, "sources");

    await mkdir(memoryPath, { recursive: true });
    await mkdir(sourcesPath, { recursive: true });

    // Write a test markdown file
    const testFile = resolve(memoryPath, "test-note.md");
    await writeFile(
      testFile,
      "# Project Context\n\nThe gateway server runs on port 18789 via Cloudflare tunnel.\n",
      "utf-8"
    );

    // Register collections and build index
    await ensureQmdCollections({ memoryPath, sourcesPath });

    // Search via QmdBackend (vsearch = L2 Ambient)
    const backend = new QmdBackend({ collections: ["memory"] });
    const hits = await backend.search("gateway server setup", 5);

    expect(hits.length).toBeGreaterThan(0);
    const hit = hits.find((h) => h.content.toLowerCase().includes("gateway"));
    expect(hit).toBeDefined();
    expect(hit!.source).toContain("test-note.md");

    await rm(testDir, { recursive: true, force: true });
  }, 600_000); // 10 min timeout for first-run model download

  it("logs skip reason when QMD is not available", () => {
    if (!qmdAvailable) {
      console.log("[SKIP] QMD not installed — smoke test skipped. Run locally after: bun install -g https://github.com/tobi/qmd");
    }
    expect(true).toBe(true);
  });
});
