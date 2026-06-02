import { createStore, type QMDStore } from "@tobilu/qmd";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryBackend } from "./memoryBackend.js";
import { QmdBackend } from "./qmdBackend.js";
import { StubBackend } from "./stubBackend.js";

export interface MemoryServiceConfig {
  memoryPath: string;
  sourcesPath: string;
  dbPath: string;
  embedModel?: string;
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
  degraded = false;

  constructor(private readonly config: MemoryServiceConfig) {}

  /**
   * Initializes the QMD store, ensures collections are registered,
   * and runs an initial update + embed.
   *
   * On failure (QMD not available, models missing, offline):
   * sets degraded=true, logs, and resolves cleanly — no crash.
   */
  async init(): Promise<void> {
    if (this.config.embedModel) {
      process.env.QMD_EMBED_MODEL = this.config.embedModel;
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

    try {
      await this.store.update();
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[harness] QMD embed failed: ${message}`);
    }

    this.backend = new QmdBackend(this.store);
    console.log(`[harness] memory service ready (db: ${this.config.dbPath})`);
  }

  /**
   * Returns the active MemoryBackend.
   * If degraded, returns a StubBackend that yields empty results.
   */
  getBackend(): MemoryBackend {
    if (this.backend) return this.backend;
    return new StubBackend();
  }

  /**
   * Shuts down the store, releasing models and DB connections.
   */
  async shutdown(): Promise<void> {
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
