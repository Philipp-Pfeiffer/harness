import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { resolveHarnessPaths } from "../config/paths.js";
import { sendIpcRequest } from "./ipc.js";
import {
  getRunningDaemonPid,
  cleanupStalePidFile,
  stopDaemon,
  removePidFile,
  isProcessAlive,
} from "./process.js";
import { installSystemdUnit } from "./systemd.js";
import { DaemonRuntime } from "./runtime.js";

export interface CliResult {
  stdout: string;
  exitCode: number;
}

/* ─── daemon start ─── */

export async function daemonStart(): Promise<CliResult> {
  const paths = resolveHarnessPaths();

  const existingPid = await getRunningDaemonPid(paths.pidFile);
  if (existingPid !== null) {
    return {
      stdout: `Daemon already running (PID ${existingPid}).`,
      exitCode: 1,
    };
  }

  // Clean up stale PID file
  await cleanupStalePidFile(paths.pidFile);

  // Spawn daemon as a detached background process
  const nodeBin = process.execPath;
  const entryPath = resolve(process.cwd(), "dist/index.js");
  const daemonProc = spawn(nodeBin, [entryPath, "daemon", "run"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  daemonProc.unref();

  // Wait briefly for the daemon to write its PID file
  await sleep(500);

  const pid = await getRunningDaemonPid(paths.pidFile);
  if (pid === null) {
    return {
      stdout: "Daemon failed to start — check logs with `harness daemon logs`.",
      exitCode: 1,
    };
  }

  return {
    stdout: `Daemon started (PID ${pid}).`,
    exitCode: 0,
  };
}

/* ─── daemon stop ─── */

export async function daemonStop(): Promise<CliResult> {
  const paths = resolveHarnessPaths();
  const pid = await getRunningDaemonPid(paths.pidFile);

  if (pid === null) {
    // Clean up any stale PID file
    await removePidFile(paths.pidFile);
    return {
      stdout: "Daemon is not running.",
      exitCode: 0,
    };
  }

  const signaled = await stopDaemon(paths.pidFile, "SIGTERM");
  if (!signaled) {
    await removePidFile(paths.pidFile);
    return {
      stdout: "Daemon was not running (stale PID file removed).",
      exitCode: 0,
    };
  }

  // Wait for the process to exit (up to 10 seconds)
  const exited = await waitForExit(pid, 10_000);
  if (!exited) {
    // Force kill
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore
    }
    await sleep(100);
  }

  await removePidFile(paths.pidFile);
  return {
    stdout: `Daemon stopped (PID ${pid}).`,
    exitCode: 0,
  };
}

/* ─── daemon restart ─── */

export async function daemonRestart(): Promise<CliResult> {
  const paths = resolveHarnessPaths();
  const pid = await getRunningDaemonPid(paths.pidFile);

  if (pid !== null) {
    const stopResult = await daemonStop();
    if (stopResult.exitCode !== 0) {
      return stopResult;
    }
  }

  // Wait briefly for socket cleanup
  await sleep(300);

  return daemonStart();
}

/* ─── daemon status ─── */

export async function daemonStatus(): Promise<CliResult> {
  const paths = resolveHarnessPaths();
  const pid = await getRunningDaemonPid(paths.pidFile);

  if (pid === null) {
    return {
      stdout: "Daemon is not running.",
      exitCode: 0,
    };
  }

  // Try to get detailed status via IPC
  try {
    const resp = await sendIpcRequest(paths.socketFile, { type: "status" });
    if (resp.type === "status") {
      const d = resp.daemon;
      const lines = [
        "Daemon Status",
        "──────────────",
        `PID:          ${d.pid}`,
        `Uptime:       ${formatUptime(d.uptime)}`,
        `Started:      ${d.startTime}`,
        `Model:        ${d.model}`,
        `Gateways:     ${d.gateways}`,
        `Turns:        ${d.turnsCompleted}`,
        `Sessions:     ${d.sessionsActive}`,
        `Socket:       ${paths.socketFile}`,
        `Last errors:  ${d.lastErrors.length === 0 ? "none" : "\n" + d.lastErrors.map((e) => "  " + e).join("\n")}`,
      ];
      return { stdout: lines.join("\n"), exitCode: 0 };
    }
  } catch {
    // IPC failed — fall back to basic status
  }

  return {
    stdout: `Daemon is running (PID ${pid}). IPC connection failed — daemon may be busy.`,
    exitCode: 0,
  };
}

/* ─── daemon install ─── */

export async function daemonInstall(): Promise<CliResult> {
  try {
    const unitPath = await installSystemdUnit();
    return {
      stdout: [
        "systemd user service installed.",
        "",
        `Unit file: ${unitPath}`,
        "",
        "To enable and start the daemon:",
        "  systemctl --user daemon-reload",
        "  systemctl --user enable harness-daemon",
        "  systemctl --user start harness-daemon",
        "",
        "To check status:",
        "  systemctl --user status harness-daemon",
      ].join("\n"),
      exitCode: 0,
    };
  } catch (err) {
    return {
      stdout: `Failed to install systemd unit: ${
        err instanceof Error ? err.message : String(err)
      }`,
      exitCode: 1,
    };
  }
}

/* ─── daemon run (internal — the actual daemon process) ─── */

export async function daemonRun(): Promise<CliResult> {
  const runtime = new DaemonRuntime();
  await runtime.start();
  // The process keeps running — the runtime handles IPC and signals
  // We never return here during normal operation
  return { stdout: "", exitCode: 0 };
}

/* ─── helpers ─── */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(200);
  }
  return false;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
