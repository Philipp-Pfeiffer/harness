import { createStore, type QMDStore } from "@tobilu/qmd";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryBackend, MemoryHit, MemoryEntry, AmbientHint } from "@harness/core";
import { QmdBackend } from "./qmdBackend.js";
import { StubBackend } from "./stubBackend.js";

export interface MemoryServiceConfig {
  memoryPath: string;
  sourcesPath: string;
  dbPath: string;
  embedModel?: string;
  /**
   * Force CPU-only inference (skips CUDA/Vulkan addon loading).
   * Default: true. Set to false to enable GPU offloading.
   * Saves ~900 MB RSS (cuBLAS libraries) on machines without a dedicated GPU.
   */
  forceCpu?: boolean;
}

/**
 * Approximate RSS budget for the QMD memory stack.
 *
 * embeddinggemma-300M-Q8_0 GGUF: ~312 MB (model weights, mmap'd)
 * llama.cpp CPU runtime + context: ~150 MB
 * SQLite + sqlite-vec: ~20 MB
 * Node.js overhead: ~38 MB
 * Total: ~520 MB resident
 *
 * With QMD_FORCE_CPU=1 (default), CUDA/cuBLAS libraries (~900 MB) are not loaded.
 */
const MEMORY_RSS_BUDGET_MB = 520;

/**
 * Wraps a QmdBackend and gates all calls behind a warmup Promise.
 *
 * - getAmbientHints: returns [] while warming up (ambient is non-blocking)
 * - query: returns a clear "index warming" message while warming up
 * - After warmup completes: delegates to the real QmdBackend
 * - If warmup fails: delegates to QmdBackend which will use whatever
 *   partial index state exists (or StubBackend if store init failed)
 */
class WarmupGatedBackend implements MemoryBackend {
  readonly name = "qmd-warming";
  private warmedUp = false;

  constructor(
    private readonly warmup: Promise<void>,
    private readonly realBackend: MemoryBackend,
  ) {
    warmup.then(
      () => { this.warmedUp = true; },
      () => { this.warmedUp = true; }, // even on error, let realBackend handle queries
    );
  }

  async search(query: string, k?: number): Promise<MemoryHit[]> {
    if (!this.warmedUp) await this.warmup.catch(() => {});
    return this.realBackend.search(query, k);
  }

  async query(query: string, k?: number): Promise<MemoryHit[]> {
    if (!this.warmedUp) {
      return [{
        source: "_warmup",
        title: "Memory index warming up",
        score: 0,
        content: "Memory index is warming up. Please retry in a few seconds.",
      }];
    }
    return this.realBackend.query(query, k);
  }

  async getAmbientHints(query: string, opts?: { k?: number; minCosine?: number }): Promise<AmbientHint[]> {
    // Ambient during warmup: silent empty (non-blocking, no UX disruption)
    if (!this.warmedUp) return [];
    return this.realBackend.getAmbientHints(query, opts);
  }

  async write(entry: MemoryEntry): Promise<void> {
    if (!this.warmedUp) await this.warmup.catch(() => {});
    return this.realBackend.write(entry);
  }
}

/**
 * Lifecycle owner for the memory subsystem.
 *
 * Design: Pure constructor injection, zero coupling to TUI/CLI.
 * A single instance is created at the outermost process scope and passed down.
 * Today the entry point is src/index.tsx; tomorrow the same class is instantiated
 * in a Gateway process and the backend is DI'd through — caller code does not change.
 */
export class MemoryService {
  private store: QMDStore | null = null;
  private backend: MemoryBackend | null = null;
  private gatedBackend: WarmupGatedBackend | null = null;
  private warmupPromise: Promise<void> | null = null;
  private warmupDone = false;
  degraded = false;

  constructor(private readonly config: MemoryServiceConfig) {}

  /**
   * Creates the QMD store and ensures collections are registered.
   *
   * Returns immediately after store creation — the heavy update() + embed()
   * runs asynchronously in the background (see warmup()). The TUI can render
   * right away; memory retrieval becomes available once warmup completes.
   *
   * On store creation failure: sets degraded=true, logs, resolves cleanly.
   */
  async init(): Promise<void> {
    if (this.config.embedModel) {
      process.env.QMD_EMBED_MODEL = this.config.embedModel;
    }

    // Force CPU-only inference by default: avoids loading CUDA/cuBLAS libraries
    // (~900 MB RSS) on machines without a dedicated GPU for the embedding model.
    // Can be disabled via MemoryServiceConfig.forceCpu = false.
    if (this.config.forceCpu !== false && !process.env.QMD_FORCE_CPU) {
      process.env.QMD_FORCE_CPU = "1";
    }

    try {
      this.store = await createStore({
        dbPath: this.config.dbPath,
        config: {
          collections: {
            memory: { path: this.config.memoryPath, pattern: "**/*.md" },
            sources: { path: this.config.sourcesPath, pattern: "**/*.md" },
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[harness] Failed to create QMD store (${this.config.dbPath}): ${message}. ` +
          `Memory retrieval unavailable.`
      );
      this.degraded = true;
      return;
    }

    await this.ensureCollections();

    // Create the real backend immediately — it can serve queries
    // using whatever index state already exists in the SQLite DB.
    this.backend = new QmdBackend(this.store, {
      collectionRoots: {
        memory: this.config.memoryPath,
        sources: this.config.sourcesPath,
      },
    });

    // Fire warmup (update + embed) in the background.
    this.warmupPromise = this.warmup();
    this.warmupPromise.then(
      () => { this.warmupDone = true; },
      () => { this.warmupDone = true; },
    );

    console.log(`[harness] memory service ready (db: ${this.config.dbPath}, RSS budget ~${MEMORY_RSS_BUDGET_MB} MB, warming up in background)`);
  }

  /**
   * Background warmup: re-indexes files and computes embeddings.
   * Stored as a Promise so callers can gate on it (WarmupGatedBackend).
   */
  private async warmup(): Promise<void> {
    if (!this.store) return;

    try {
      await this.store.update();
      console.log(`[harness] QMD update complete`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[harness] QMD update failed: ${message}`);
    }

    try {
      const force = await this.shouldForceEmbed();
      await this.store.embed({ force });
      if (force || this.config.embedModel) {
        await this.writeEmbedModelMarker();
      }
      console.log(`[harness] QMD embed complete — memory fully warm`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[harness] QMD embed failed: ${message}`);
    }

    // Pre-warm the embedding model: fire a dummy searchVector call so
    // the model is loaded into memory before the first user turn.
    // This eliminates the ~1–2s cold-start latency on the first ambient hint.
    try {
      await this.store.searchVector("warmup", { limit: 1 });
      console.log(`[harness] QMD embedding model pre-warmed`);
    } catch {
      // Pre-warm is best-effort; failures are non-critical
    }
  }

  /**
   * Returns the active MemoryBackend.
   *
   * If warmup is in progress, returns a WarmupGatedBackend that:
   *   - getAmbientHints → [] (silent, non-blocking)
   *   - query → "index warming" message (explicit, user-facing)
   *
   * If degraded, returns a StubBackend.
   */
  getBackend(): MemoryBackend {
    if (this.degraded || !this.backend) return new StubBackend();
    // After warmup is done, return the real backend directly (no gate)
    if (this.warmupDone) return this.backend;
    if (this.gatedBackend) return this.gatedBackend;
    if (this.warmupPromise) {
      this.gatedBackend = new WarmupGatedBackend(this.warmupPromise, this.backend);
      return this.gatedBackend;
    }
    return this.backend;
  }

  /**
   * Shuts down the store, releasing models and DB connections.
   */
  async shutdown(): Promise<void> {
    // Wait for warmup to finish before closing the store
    if (this.warmupPromise) {
      await this.warmupPromise.catch(() => {});
    }
    if (this.store) {
      await this.store.close();
      this.store = null;
    }
  }

  private get markerPath(): string {
    return dirname(this.config.dbPath) + "/.embed-model";
  }

  private async shouldForceEmbed(): Promise<boolean> {
    if (!this.config.embedModel) return false;
    try {
      const lastModel = await readFile(this.markerPath, "utf-8");
      return lastModel.trim() !== this.config.embedModel;
    } catch {
      // No marker file → first run with explicit model; incremental embed is sufficient
      return false;
    }
  }

  private async writeEmbedModelMarker(): Promise<void> {
    if (!this.config.embedModel) return;
    try {
      await writeFile(this.markerPath, this.config.embedModel, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[harness] Failed to write embed model marker: ${message}`);
    }
  }

  private async ensureCollections(): Promise<void> {
    if (!this.store) return;

    const existing = await this.store.listCollections();
    const existingNames = new Set(existing.map((c) => c.name));

    const needed = [
      { name: "memory", path: this.config.memoryPath },
      { name: "sources", path: this.config.sourcesPath },
    ];

    const registered: string[] = [];
    const skipped: string[] = [];

    for (const { name, path } of needed) {
      if (existingNames.has(name)) {
        skipped.push(name);
        continue;
      }
      try {
        await this.store.addCollection(name, { path, pattern: "**/*.md" });
        registered.push(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[harness] Failed to add QMD collection "${name}": ${message}`);
      }
    }

    const status = [
      registered.length > 0 ? `registered: ${registered.join(", ")}` : "",
      skipped.length > 0 ? `already present: ${skipped.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");

    console.log(`[harness] qmd collections ready${status ? ` — ${status}` : ""}`);
  }
}
