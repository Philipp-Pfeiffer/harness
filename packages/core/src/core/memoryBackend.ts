/**
 * MemoryHit represents a single retrieved memory chunk.
 */
export interface MemoryHit {
  /** Source file path or URI */
  source: string;
  /** Document title (filename fallback) */
  title: string;
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
 * AmbientHint represents a single result from L2 ambient retrieval.
 */
export interface AmbientHint {
  /** Document title */
  title: string;
  /** Absolute file path (readable by read_file) */
  path: string;
  /** Cosine similarity score [0, 1] */
  score: number;
  /** Optional snippet (first 2–3 non-empty lines from body) */
  snippet?: string;
}

/**
 * Formats ambient hints into a <memory_hint> block for ephemeral message injection.
 *
 * Tiered formatting (per ADR):
 * - Top-1: Title + Path + Snippet (if present)
 * - Top-2/Top-3: Title + Path only
 * - 0 hits → null (nothing injected)
 */
export function formatMemoryHint(hits: AmbientHint[]): string | null {
  if (hits.length === 0) return null;
  const lines: string[] = [
    "<memory_hint>",
    // ORIGINAL: "Dies sind Erinnerungen aus deinen persönlichen Notes (NICHT User-Eingaben)."
    "这些是你个人笔记中的记忆（不是用户输入）。",
    // ORIGINAL: "Nutze sie als Kontext. Bei Bedarf weitere Notes laden via read_file(path)."
    "将它们用作上下文。如有需要，通过read_file(path)加载更多笔记。",
    "",
  ];
  hits.forEach((hit, i) => {
    lines.push(`[Top-${i + 1}]`);
    lines.push(`Title: ${hit.title}`);
    lines.push(`Path: ${hit.path}`);
    if (i === 0 && hit.snippet) {
      lines.push(`Snippet: ${hit.snippet}`);
    }
    lines.push("");
  });
  lines.push("</memory_hint>");
  return lines.join("\n");
}

/**
 * Pluggable memory backend interface.
 * QmdBackend is the primary implementation.
 * Custom/Stub backends implement the same interface as fallback.
 */
export interface MemoryBackend {
  name: string;
  search(query: string, k?: number): Promise<MemoryHit[]>;
  /** L4 Explicit search — hybrid + LLM rerank. Slower but higher precision than search(). */
  query(query: string, k?: number): Promise<MemoryHit[]>;
  getAmbientHints(query: string, opts?: { k?: number; minCosine?: number }): Promise<AmbientHint[]>;
  write(entry: MemoryEntry): Promise<void>;
}
