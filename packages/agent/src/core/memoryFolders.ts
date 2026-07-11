import { writeFile, access } from "node:fs/promises";
import { resolveHarnessPaths } from "@harness/core";

/**
 * Ensures the _inbox.md file exists. Creates it with a default header
 * if it doesn't. Idempotent — safe to call on every startup.
 *
 * Directory creation is handled by `ensureDirs()`, not here.
 */
export async function ensureInbox(inboxPath: string): Promise<void> {
  try {
    await access(inboxPath);
  } catch {
    await writeFile(
      inboxPath,
      "# Inbox\n\n<!-- Ungestrukturerte Gedanken, TODOs, Quick Notes -->\n\n",
      "utf-8"
    );
  }
}

/**
 * @deprecated Use `resolveHarnessPaths()` from `src/config/paths.ts` instead.
 * Kept temporarily for backward compatibility with any code that still
 * imports resolveMemoryConfig. Will be removed in a future commit.
 */
export function resolveMemoryConfig(
  env: Record<string, string | undefined> = process.env,
): { memoryPath: string; sourcesPath: string; inboxPath: string } {
  const paths = resolveHarnessPaths(
    env.HARNESS_HOME ? { home: env.HARNESS_HOME } : undefined
  );
  return {
    memoryPath: paths.memory,
    sourcesPath: paths.sources,
    inboxPath: paths.inbox,
  };
}
