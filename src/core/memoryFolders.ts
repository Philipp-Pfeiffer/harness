import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface MemoryFolderConfig {
  /** Absolute path to the memory directory. Default: <projectRoot>/memory */
  memoryPath: string;
  /** Absolute path to the sources directory. Default: <projectRoot>/sources */
  sourcesPath: string;
  /** Absolute path to the inbox file. Default: <projectRoot>/memory/_inbox.md */
  inboxPath: string;
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function getProjectRoot(): string {
  return process.env.HARNESS_PROJECT_ROOT ?? process.cwd();
}

/**
 * Resolves memory folder paths from environment or project-root defaults.
 * Env overrides (HARNESS_MEMORY_PATH, HARNESS_SOURCES_PATH, HARNESS_INBOX_PATH)
 * always take precedence. Paths starting with ~ are expanded to the home dir.
 */
export function resolveMemoryConfig(
  env: Record<string, string | undefined> = process.env,
  projectRoot = getProjectRoot()
): MemoryFolderConfig {
  const memoryPath = env.HARNESS_MEMORY_PATH
    ? expandHome(env.HARNESS_MEMORY_PATH)
    : resolve(projectRoot, "memory");

  const sourcesPath = env.HARNESS_SOURCES_PATH
    ? expandHome(env.HARNESS_SOURCES_PATH)
    : resolve(projectRoot, "sources");

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
