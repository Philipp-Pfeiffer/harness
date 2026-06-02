import { describe, it, expect, beforeAll } from "vitest";
import { createStore } from "@tobilu/qmd";
import { QmdBackend } from "../../src/core/qmdBackend.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Real QMD SDK smoke test.
 * Skips gracefully if QMD native dependencies are unavailable (e.g. in CI).
 */

let sdkAvailable = false;

beforeAll(async () => {
  try {
    const testDir = resolve(tmpdir(), `harness-qmd-smoke-check-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const store = await createStore({
      dbPath: resolve(testDir, "test.sqlite"),
      config: {
        collections: {
          test: { path: testDir, pattern: "**/*.md" },
        },
      },
    });
    await store.close();
    await rm(testDir, { recursive: true, force: true });
    sdkAvailable = true;
  } catch {
    sdkAvailable = false;
  }
});

describe("QMD SDK Smoke Test", () => {
  it.skipIf(!sdkAvailable)("end-to-end: write, index, and retrieve via SDK", async () => {
    const testDir = resolve(tmpdir(), `harness-qmd-smoke-${Date.now()}`);
    const memoryPath = resolve(testDir, "memory");

    await mkdir(memoryPath, { recursive: true });

    const testFile = resolve(memoryPath, "test-note.md");
    await writeFile(
      testFile,
      "# Project Context\n\nThe gateway server runs on port 18789 via Cloudflare tunnel.\n",
      "utf-8"
    );

    const store = await createStore({
      dbPath: resolve(testDir, "index.sqlite"),
      config: {
        collections: {
          memory: { path: memoryPath, pattern: "**/*.md" },
        },
      },
    });

    await store.update();
    await store.embed();

    const backend = new QmdBackend(store);

    // L2 Ambient (vector search)
    const ambientHits = await backend.search("gateway server setup", 5, { mode: "ambient" });
    expect(ambientHits.length).toBeGreaterThan(0);
    const ambientHit = ambientHits.find((h) => h.content.toLowerCase().includes("gateway"));
    expect(ambientHit).toBeDefined();

    // L4 Explicit (hybrid search)
    const explicitHits = await backend.search("gateway server setup", 5, { mode: "explicit" });
    expect(explicitHits.length).toBeGreaterThan(0);
    const explicitHit = explicitHits.find((h) => h.content.toLowerCase().includes("gateway"));
    expect(explicitHit).toBeDefined();

    await store.close();
    await rm(testDir, { recursive: true, force: true });
  }, 600_000); // 10 min timeout for first-run model download

  it("logs skip reason when SDK is not available", () => {
    if (!sdkAvailable) {
      console.log("[SKIP] QMD SDK not available — smoke test skipped. Install: npm install @tobilu/qmd");
    }
    expect(true).toBe(true);
  });
});
