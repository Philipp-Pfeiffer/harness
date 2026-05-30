import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface MemoryFolderConfig {
  /** Absolute path to the memory directory. Default: ~/memory */
  memoryPath: string;
  /** Absolute path to the sources directory. Default: ~/sources */
  sourcesPath: string;
  /** Absolute path to the inbox file. Default: ~/memory/_inbox.md */
  inboxPath: string;
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

/**
 * Resolves memory folder paths from environment or defaults.
 */
export function resolveMemoryConfig(
  env: Record<string, string | undefined> = process.env
): MemoryFolderConfig {
  const memoryPath = expandHome(env.HARNESS_MEMORY_PATH ?? "~/memory");
  const sourcesPath = expandHome(env.HARNESS_SOURCES_PATH ?? "~/sources");
  const inboxPath = env.HARNESS_INBOX_PATH
    ? expandHome(env.HARNESS_INBOX_PATH)
    : resolve(memoryPath, "_inbox.md");

  return { memoryPath, sourcesPath, inboxPath };
}

/**
 * Idempotently creates memory folders and the inbox file.
 * Safe to call on every startup.
 */
export async function ensureMemoryFolders(
  config?: Partial<MemoryFolderConfig>
): Promise<MemoryFolderConfig> {
  const resolved = resolveMemoryConfig();
  const memoryPath = config?.memoryPath ?? resolved.memoryPath;
  const sourcesPath = config?.sourcesPath ?? resolved.sourcesPath;
  const inboxPath = config?.inboxPath ?? resolved.inboxPath;

  await mkdir(memoryPath, { recursive: true });
  await mkdir(sourcesPath, { recursive: true });

  try {
    await access(inboxPath);
  } catch {
    await writeFile(
      inboxPath,
      "# Inbox\n\n<!-- Ungestrukturierte Gedanken, TODOs, Quick Notes -->\n\n",
      "utf-8"
    );
  }

  return { memoryPath, sourcesPath, inboxPath };
}
