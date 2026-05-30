/**
 * MemoryHit represents a single retrieved memory chunk.
 */
export interface MemoryHit {
  /** Source file path or URI */
  source: string;
  /** Relevance score (0.0–1.0, backend-specific) */
  score: number;
  /** Chunk text content */
  content: string;
  /** Optional line number or chunk index */
  line?: number;
}

/**
 * MemoryEntry represents a writeable memory item.
 */
export interface MemoryEntry {
  /** Target file path (relative to memory root or absolute) */
  path: string;
  /** Markdown content to write */
  content: string;
}

/**
 * Pluggable memory backend interface.
 * QmdBackend is the primary implementation.
 * Custom/Stub backends implement the same interface as fallback.
 */
export interface MemoryBackend {
  name: string;
  search(query: string, k?: number): Promise<MemoryHit[]>;
  write(entry: MemoryEntry): Promise<void>;
}
