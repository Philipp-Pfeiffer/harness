import type { MemoryBackend, MemoryHit, MemoryEntry, AmbientHint } from "@harness/core";

/**
 * Stub backend that always returns empty results.
 * Used as a fallback when QMD is not available.
 */
export class StubBackend implements MemoryBackend {
  readonly name = "stub";

  async search(_query: string, _k?: number): Promise<MemoryHit[]> {
    return [];
  }

  async query(_query: string, _k?: number): Promise<MemoryHit[]> {
    return [];
  }

  async getAmbientHints(_query: string, _opts?: { k?: number; minCosine?: number }): Promise<AmbientHint[]> {
    return [];
  }

  async write(entry: MemoryEntry): Promise<void> {
    // No-op in stub mode
    void entry;
  }
}
