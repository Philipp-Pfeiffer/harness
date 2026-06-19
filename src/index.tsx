#!/usr/bin/env node
import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { render } from "ink";
import { resolveHarnessPaths, ensureDirs, type HarnessPaths } from "./config/paths.js";
import { ensureInbox } from "./core/memoryFolders.js";
import { MemoryService } from "./core/memoryService.js";

// ─── Subcommand: migrate-home ─────────────────────────────────
if (process.argv[2] === "migrate-home") {
  const { migrateHome } = await import("./cli/migrateHome.js");
  const dryRun = process.argv.includes("--dry-run");
  const projectRoot = process.cwd();
  const result = await migrateHome(dryRun, projectRoot);
  process.exit(result.dryRun || result.moved.length > 0 || result.indexNeedsRebuild ? 0 : 0);
}

if (!process.stdin.isTTY) {
  console.error("harness requires an interactive terminal (TTY).");
  console.error("Run without piping stdin, or use an interactive shell.");
  process.exit(1);
}

const projectRoot = process.cwd();
process.env.HARNESS_PROJECT_ROOT = projectRoot;

// Resolve all harness paths from a single source of truth.
const paths: HarnessPaths = resolveHarnessPaths();

// Ensure HOME + STATE directories exist.
await ensureDirs(paths);
await ensureInbox(paths.inbox);
console.log(`[harness] home: ${paths.home}`);
console.log(`[harness] state: ${paths.state}`);

// Workspace stays cwd-based (the "workspace" concept ≠ HARNESS_HOME).
await mkdir(resolve(projectRoot, "workspace"), { recursive: true });

const dbPath = resolve(paths.index, "index.sqlite");
await mkdir(paths.index, { recursive: true });

const memoryService = new MemoryService({
  memoryPath: paths.memory,
  sourcesPath: paths.sources,
  dbPath,
});
await memoryService.init();

process.chdir(resolve(projectRoot, "workspace"));

const { default: App } = await import("./cli/App.js");
render(<App memoryService={memoryService} paths={paths} />);

// Graceful shutdown on exit signals
async function shutdown() {
  await memoryService.shutdown();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
