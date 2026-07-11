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
dotenv.config({ path: resolve(_earlyPaths.home, ".env"), quiet: true });
dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });

// ─── Subcommand: migrate-home ─────────────────────────────────
if (process.argv[2] === "migrate-home") {
  const { migrateHome } = await import("./cli/migrateHome.js");
  const dryRun = process.argv.includes("--dry-run");
  const projectRoot = process.cwd();
  const result = await migrateHome(dryRun, projectRoot);
  process.exit(result.dryRun || result.moved.length > 0 || result.indexNeedsRebuild ? 0 : 0);
}

// ─── Subcommand: sessions ─────────────────────────────────────
if (process.argv[2] === "sessions") {
  const { harnessSessions } = await import("./daemon/commands.js");
  const result = await harnessSessions();
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
}

// ─── Subcommand: send ──────────────────────────────────────────
if (process.argv[2] === "send") {
  const { harnessSend } = await import("./daemon/commands.js");
  // Parse: harness send [--session <id>] "message"
  const args = process.argv.slice(3);
  let sessionId: string | undefined;
  let message: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && i + 1 < args.length) {
      sessionId = args[i + 1];
      i++;
    } else if (!args[i].startsWith("-")) {
      message = args[i];
    }
  }

  if (!message) {
    console.error('Usage: harness send [--session <id>] "message"');
    process.exit(1);
  }

  const result = await harnessSend(message, sessionId);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
}

// ─── Subcommand: chat ─────────────────────────────────────────
if (process.argv[2] === "chat") {
  const { harnessChat } = await import("./daemon/commands.js");
  // Parse: harness chat [--session <id>]
  const args = process.argv.slice(3);
  let sessionId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && i + 1 < args.length) {
      sessionId = args[i + 1];
      i++;
    }
  }

  const result = await harnessChat(sessionId);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
}

// ─── Subcommand: daemon ────────────────────────────────────────
if (process.argv[2] === "daemon") {
  const subcommand = process.argv[3] ?? "status";
  const { daemonStart, daemonStop, daemonRestart, daemonStatus, daemonInstall, daemonRun, daemonLogs } =
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
    case "logs":
      ({ stdout, exitCode } = await daemonLogs());
      break;
    case "run":
      // Internal: the actual daemon process (spawned by `daemon start`)
      await daemonRun();
      // daemonRun blocks forever — we never reach here
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

// Reject unknown subcommands before any heavy initialization.
const knownCommands = new Set([undefined, "migrate-home", "daemon", "reload-config", "sessions", "send", "chat"]);
if (!knownCommands.has(process.argv[2])) {
  console.error(`Unknown command: ${process.argv[2] ?? ""}`);
  console.error("Usage: harness [daemon|sessions|send|chat|migrate-home|reload-config]");
  process.exit(1);
}

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
