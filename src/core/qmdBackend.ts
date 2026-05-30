import { execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { MemoryBackend, MemoryHit, MemoryEntry } from "./memoryBackend.js";

export interface QmdBackendOptions {
  /** Absolute path to the qmd binary. Defaults to "qmd" (PATH lookup). */
  binaryPath?: string;
  /** Collections to search (qmd --collection flag). If omitted, searches all. */
  collections?: string[];
  /** Default number of results. */
  defaultK?: number;
}

/**
 * Raw result shape from qmd --json output.
 * QMD returns an array of { file, score, content, line? } objects.
 */
interface QmdJsonResult {
  file?: string;
  score?: number;
  content?: string;
  line?: number;
  chunk?: string;
}

function runQmd(
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });

    // Defensive: if the process hangs, kill it after timeout + buffer
    // execFile timeout sends SIGTERM, which is usually sufficient.
    if (!child.pid) {
      reject(new Error("Failed to spawn qmd process"));
    }
  });
}

function parseQmdJson(raw: string): QmdJsonResult[] {
  try {
    const parsed = JSON.parse(raw) as QmdJsonResult[] | { results?: QmdJsonResult[] };
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.results)) return parsed.results;
    return [];
  } catch {
    return [];
  }
}

function normalizeHits(results: QmdJsonResult[]): MemoryHit[] {
  return results
    .filter((r) => r.content || r.chunk)
    .map((r) => ({
      source: r.file ?? "unknown",
      score: typeof r.score === "number" ? r.score : 0,
      content: (r.content ?? r.chunk ?? "").trim(),
      line: typeof r.line === "number" ? r.line : undefined,
    }));
}

export class QmdBackend implements MemoryBackend {
  readonly name = "qmd";
  private readonly binary: string;
  private readonly collections: string[];
  private readonly defaultK: number;

  constructor(options: QmdBackendOptions = {}) {
    this.binary = options.binaryPath ?? "qmd";
    this.collections = options.collections ?? [];
    this.defaultK = options.defaultK ?? 5;
  }

  /**
   * L2 Ambient search — vector-only, no LLM, budget <100ms.
   * Maps to `qmd vsearch --json`.
   */
  async vsearch(query: string, k = this.defaultK): Promise<MemoryHit[]> {
    const args = ["vsearch", query, "--json", "-n", String(k)];
    for (const c of this.collections) {
      args.push("--collection", c);
    }

    const { stdout } = await runQmd(this.binary, args, 30_000);
    const results = parseQmdJson(stdout);
    return normalizeHits(results);
  }

  /**
   * L4 Explicit search — hybrid + LLM rerank, ~1.7s.
   * Maps to `qmd query --json`.
   */
  async query(query: string, k = this.defaultK): Promise<MemoryHit[]> {
    const args = ["query", query, "--json", "-n", String(k)];
    for (const c of this.collections) {
      args.push("--collection", c);
    }

    const { stdout } = await runQmd(this.binary, args, 120_000);
    const results = parseQmdJson(stdout);
    return normalizeHits(results);
  }

  /**
   * Generic search entry point. Defaults to vsearch (fast) unless
   * the caller explicitly wants deep retrieval.
   *
   * To use L4 explicit, call `backend.query(q, k)` directly.
   */
  async search(query: string, k?: number): Promise<MemoryHit[]> {
    return this.vsearch(query, k);
  }

  /**
   * Writes a memory entry to disk as a Markdown file.
   * Creates parent directories as needed.
   */
  async write(entry: MemoryEntry): Promise<void> {
    const dir = dirname(entry.path);
    await mkdir(dir, { recursive: true });
    await writeFile(entry.path, entry.content, "utf-8");
  }
}
