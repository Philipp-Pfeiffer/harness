#!/usr/bin/env node
import dotenv from "dotenv";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { render } from "ink";
import { resolveHarnessPaths, ensureDirs, type HarnessPaths } from "./config/paths.js";
import { ensureInbox } from "./core/memoryFolders.js";
import { MemoryService } from "./core/memoryService.js";

// ─── Subcommand: migrate-home ─────────────────────────────────
// Resolve paths early so we can load .env from $HARNESS_HOME.
const _earlyPaths = resolveHarnessPaths();
// Load .env from $HARNESS_HOME first (production), then cwd (dev override).
dotenv.config({ path: resolve(_earlyPaths.home, ".env") });
dotenv.config({ path: resolve(process.cwd(), ".env") });

// ─── Subcommand: migrate-home ─────────────────────────────────
if (process.argv[2] === "migrate-home") {
  const { migrateHome } = await import("./cli/migrateHome.js");
  const dryRun = process.argv.includes("--dry-run");
  const projectRoot = process.cwd();
  const result = await migrateHome(dryRun, projectRoot);
  process.exit(result.dryRun || result.moved.length > 0 || result.indexNeedsRebuild ? 0 : 0);
}

// ─── Subcommand: daemon ────────────────────────────────────────
if (process.argv[2] === "daemon") {
  const subcommand = process.argv[3] ?? "status";
  const { daemonStart, daemonStop, daemonRestart, daemonStatus, daemonInstall, daemonRun } =
    await import("./daemon/commands.js");

  let exitCode = 0;
  let stdout: string;

  switch (subcommand) {
    case "start":
      ({ stdout, exitCode } = await daemonStart());
      break;
    case "stop":
      ({ stdout, exitCode } = await daemonStop());
      break;
    case "restart":
      ({ stdout, exitCode } = await daemonRestart());
      break;
    case "status":
      ({ stdout, exitCode } = await daemonStatus());
      break;
    case "install":
      ({ stdout, exitCode } = await daemonInstall());
      break;
    case "run":
      // Internal: the actual daemon process (spawned by `daemon start`)
      ({ exitCode } = await daemonRun());
      stdout = "";
      break;
    default:
      stdout = `Unknown daemon subcommand: ${subcommand}\nUsage: harness daemon [start|stop|restart|status|install|run]`;
      exitCode = 1;
  }

  if (stdout) console.log(stdout);
  process.exit(exitCode);
}

// ─── Subcommand: reload-config ────────────────────────────────
if (process.argv[2] === "reload-config") {
  const { sendIpcRequest } = await import("./daemon/ipc.js");
  const paths = resolveHarnessPaths();
  try {
    const resp = await sendIpcRequest(paths.socketFile, { type: "reload-config" });
    if (resp.type === "config-reloaded") {
      console.log(resp.ok ? "Config reloaded." : "Config reload failed.");
      if (resp.message) console.log(resp.message);
      process.exit(resp.ok ? 0 : 1);
    }
    console.error("Unexpected response from daemon:", resp.type);
    process.exit(1);
  } catch (err) {
    console.error("Cannot reach daemon:", err instanceof Error ? err.message : String(err));
    console.error("Is the daemon running? Start it with: harness daemon start");
    process.exit(1);
  }
}

// ─── Interactive TUI mode (default) ───────────────────────────
if (!process.stdin.isTTY) {
  console.error("harness requires an interactive terminal (TTY).");
  console.error("Run without piping stdin, or use an interactive shell.");
  console.error("For non-interactive use, start the daemon: harness daemon start");
  process.exit(1);
}

// Resolve all harness paths from a single source of truth.
const paths: HarnessPaths = resolveHarnessPaths();

// Ensure HOME + STATE directories exist.
await ensureDirs(paths);
await ensureInbox(paths.inbox);
console.log(`[harness] home: ${paths.home}`);
console.log(`[harness] state: ${paths.state}`);

const dbPath = resolve(paths.index, "index.sqlite");
await mkdir(paths.index, { recursive: true });

const memoryService = new MemoryService({
  memoryPath: paths.memory,
  sourcesPath: paths.sources,
  dbPath,
});
await memoryService.init();

// Workspace = cwd (where the user started harness). No subdir creation.
const { default: App } = await import("./cli/App.js");
render(<App memoryService={memoryService} paths={paths} />);

// Graceful shutdown on exit signals
async function shutdown() {
  await memoryService.shutdown();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
