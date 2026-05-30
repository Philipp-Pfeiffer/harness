import { execFile } from "node:child_process";

export interface QmdSetupOptions {
  /** Absolute path to the qmd binary. Defaults to "qmd" (PATH lookup). */
  binaryPath?: string;
  /** Memory folder to register. */
  memoryPath: string;
  /** Sources folder to register. */
  sourcesPath: string;
}

function runQmd(
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/**
 * Idempotently ensures QMD collections for memory and sources are registered.
 * Runs `qmd collection add` for each folder (silently accepts "already exists").
 * Then runs `qmd update` and `qmd embed` to build the index.
 *
 * If QMD is not installed, logs a clear warning and resolves cleanly — no crash.
 */
export async function ensureQmdCollections(
  options: QmdSetupOptions
): Promise<void> {
  const binary = options.binaryPath ?? "qmd";
  const collections: { name: string; path: string }[] = [
    { name: "memory", path: options.memoryPath },
    { name: "sources", path: options.sourcesPath },
  ];

  // Check if qmd is available
  try {
    await runQmd(binary, ["--version"], 5_000);
  } catch {
    console.warn(
      `[harness] QMD not found (${binary}). Memory retrieval will be unavailable. ` +
        `Install via: bun install -g https://github.com/tobi/qmd`
    );
    return;
  }

  const registered: string[] = [];
  const skipped: string[] = [];

  for (const { name, path } of collections) {
    try {
      const { stderr } = await runQmd(
        binary,
        ["collection", "add", path, "--name", name, "--mask", "**/*.md"],
        30_000
      );
      if (stderr.toLowerCase().includes("already") || stderr.toLowerCase().includes("exists")) {
        skipped.push(name);
      } else {
        registered.push(name);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Treat "already exists" style errors as idempotent success
      if (message.toLowerCase().includes("already") || message.toLowerCase().includes("exists")) {
        skipped.push(name);
      } else {
        console.warn(`[harness] Failed to register QMD collection "${name}": ${message}`);
      }
    }
  }

  // Build / update index
  try {
    await runQmd(binary, ["update"], 60_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[harness] qmd update failed: ${message}`);
  }

  // Build embeddings (vector search prerequisite)
  try {
    await runQmd(binary, ["embed"], 300_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[harness] qmd embed failed: ${message}`);
  }

  const status = [
    registered.length > 0 ? `registered: ${registered.join(", ")}` : "",
    skipped.length > 0 ? `already present: ${skipped.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  console.log(`[harness] qmd collections ready${status ? ` — ${status}` : ""}`);
}
