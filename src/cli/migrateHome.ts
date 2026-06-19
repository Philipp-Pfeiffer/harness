import { rename, stat, access } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { resolveHarnessPaths, ensureDirs, type HarnessPaths } from "../config/paths.js";

interface PlannedMove {
  source: string;
  target: string;
  description: string;
}

/**
 * Determines which durable substrate files/dirs need to be moved
 * from their current (legacy) locations to $HARNESS_HOME.
 *
 * Only moves things that actually exist at the legacy location and
 * don't already exist at the target.
 */
async function planMigration(
  paths: HarnessPaths,
  projectRoot: string,
): Promise<{ moves: PlannedMove[]; indexNeedsRebuild: boolean }> {
  const moves: PlannedMove[] = [];

  // Legacy locations in the project root
  const legacyItems: Array<{
    source: string;
    target: string;
    description: string;
  }> = [
    {
      source: resolve(projectRoot, "core.md"),
      target: paths.core,
      description: "core.md",
    },
    {
      source: resolve(projectRoot, "AGENTS.md"),
      target: paths.agents,
      description: "AGENTS.md",
    },
    {
      source: resolve(projectRoot, "harness.config.json"),
      target: paths.config,
      description: "harness.config.json → config.json",
    },
    {
      source: resolve(projectRoot, "memory"),
      target: paths.memory,
      description: "memory/",
    },
    {
      source: resolve(projectRoot, "sources"),
      target: paths.sources,
      description: "sources/",
    },
  ];

  for (const item of legacyItems) {
    try {
      await access(item.source);
      // Source exists — check if target already exists
      try {
        await access(item.target);
        // Both exist — skip to avoid overwrite
      } catch {
        moves.push(item);
      }
    } catch {
      // Source doesn't exist — skip
    }
  }

  // Check if a legacy .qmd index exists (needs reindex, not move)
  const legacyIndex = resolve(projectRoot, ".qmd", "index.sqlite");
  let indexNeedsRebuild = false;
  try {
    await access(legacyIndex);
    indexNeedsRebuild = true;
  } catch {
    // No legacy index
  }

  return { moves, indexNeedsRebuild };
}

/**
 * Runs the migration. Moves durable substrate to $HARNESS_HOME and
 * creates $HARNESS_STATE directory structure.
 *
 * Idempotent: if files are already at their target, they're skipped.
 *
 * @param dryRun  When true, prints planned moves without executing.
 * @param projectRoot  The cwd (legacy substrate location).
 * @param log   Optional log function (defaults to console.log).
 * @returns Summary of what was done.
 */
export async function migrateHome(
  dryRun: boolean = false,
  projectRoot: string = process.env.HARNESS_PROJECT_ROOT ?? process.cwd(),
  log: (msg: string) => void = console.log,
): Promise<{
  moved: string[];
  skipped: string[];
  indexNeedsRebuild: boolean;
  dryRun: boolean;
}> {
  const paths = resolveHarnessPaths();

  // Plan moves BEFORE ensuring dirs — otherwise ensureDirs creates
  // the target directories and they'd appear as "already exist".
  const { moves, indexNeedsRebuild } = await planMigration(paths, projectRoot);

  // Ensure target dirs exist (even in dry-run, for display purposes)
  if (!dryRun) {
    await ensureDirs(paths);
  }

  log(`\nHarness Home Migration`);
  log(`──────────────────────`);
  log(`Home:  ${paths.home}`);
  log(`State: ${paths.state}`);
  log(`Source (project root): ${projectRoot}`);
  log(``);

  if (moves.length === 0 && !indexNeedsRebuild) {
    log(`Nothing to migrate — everything is already in place.`);
    return { moved: [], skipped: [], indexNeedsRebuild: false, dryRun };
  }

  if (dryRun) {
    log(`Dry run — planned actions (no changes will be made):`);
    for (const move of moves) {
      log(`  MOVE  ${move.source}`);
      log(`    →   ${move.target}`);
      log(`       (${move.description})`);
    }
    if (indexNeedsRebuild) {
      log(`  REINDEX  ${resolve(projectRoot, ".qmd", "index.sqlite")}`);
      log(`    →      Run 'harness reindex' after migration`);
    }
    log(`\nDry run complete. ${moves.length} move(s) planned.`);
    return { moved: [], skipped: [], indexNeedsRebuild, dryRun: true };
  }

  const moved: string[] = [];
  const skipped: string[] = [];

  for (const move of moves) {
    try {
      // Ensure parent dir of target exists
      const targetDir = resolve(move.target, "..");
      try {
        await stat(targetDir);
      } catch {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(targetDir, { recursive: true });
      }

      await rename(move.source, move.target);
      moved.push(move.description);
      log(`  ✓ Moved ${move.description}: ${move.source} → ${move.target}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push(`${move.description} (${message})`);
      log(`  ✗ Skipped ${move.description}: ${message}`);
    }
  }

  if (indexNeedsRebuild) {
    log(`  ℹ Legacy index found at ${resolve(projectRoot, ".qmd")}.`);
    log(`    The index is NOT moved (it's regenerable).`);
    log(`    Run 'harness reindex' to rebuild the cache at ${paths.index}.`);
  }

  log(`\nMigration complete: ${moved.length} moved, ${skipped.length} skipped.`);
  if (indexNeedsRebuild) {
    log(`Reindex required — run 'harness reindex'.`);
  }

  // Write migration log
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const logDir = resolve(paths.home, "docs", "changes");
  try {
    await mkdir(logDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const logContent = [
      `# Migration Log — ${timestamp}`,
      ``,
      `## Summary`,
      `- Moved: ${moved.length} item(s)`,
      `- Skipped: ${skipped.length} item(s)`,
      `- Index rebuild needed: ${indexNeedsRebuild}`,
      `- Dry run: ${dryRun}`,
      ``,
      `## Details`,
      ``,
      ...moved.map((m) => `- ✓ ${m}`),
      ...skipped.map((s) => `- ✗ ${s}`),
      indexNeedsRebuild ? `\n**Index:** Run \`harness reindex\` to rebuild.` : "",
      ``,
    ].join("\n");
    await writeFile(join(logDir, "migration-log.md"), logContent, "utf-8");
  } catch {
    // Best-effort log write
  }

  return { moved, skipped, indexNeedsRebuild, dryRun };
}
