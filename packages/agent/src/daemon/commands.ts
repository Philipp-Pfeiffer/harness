import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";

import { resolveHarnessPaths } from "@harness/core";
import { sendIpcRequest, sendIpcStreaming } from "./ipc.js";
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

  // Poll for the daemon to write its PID file (up to 10 seconds).
  // The daemon's startup includes Memory/QMD bootstrap which can take
  // several seconds on first run.
  let pid: number | null = null;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    pid = await getRunningDaemonPid(paths.pidFile);
    if (pid !== null) break;
  }

  if (pid === null) {
    const logFile = join(paths.logs, `daemon-${new Date().toISOString().slice(0, 10)}.log`);
    return {
      stdout: `Daemon failed to start — check logs at ${logFile}`,
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

/* ─── daemon logs ─── */

export async function daemonLogs(): Promise<CliResult> {
  const paths = resolveHarnessPaths();
  try {
    const files = await readdir(paths.logs);
    const logFiles = files
      .filter((f) => f.startsWith("daemon-") && f.endsWith(".log"))
      .sort();
    if (logFiles.length === 0) {
      return {
        stdout: `No daemon log files found in ${paths.logs}`,
        exitCode: 0,
      };
    }
    const latest = logFiles[logFiles.length - 1];
    const logPath = join(paths.logs, latest);
    const content = await readFile(logPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-100);
    return {
      stdout: `--- ${logPath} (last ${tail.length} of ${lines.length} lines) ---\n${tail.join("\n")}`,
      exitCode: 0,
    };
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        stdout: `No daemon log directory found at ${paths.logs}`,
        exitCode: 0,
      };
    }
    return {
      stdout: `Failed to read logs: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    };
  }
}

/* ─── daemon install ─── */

export async function daemonInstall(): Promise<CliResult> {
  try {
    const unitPath = await installSystemdUnit();
    const lines = [
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
    ];

    // Warn if the running daemon is older than the installed build.
    const staleWarning = await checkStaleDaemon();
    if (staleWarning) {
      lines.push("", "⚠ " + staleWarning);
    }

    return { stdout: lines.join("\n"), exitCode: 0 };
  } catch (err) {
    return {
      stdout: `Failed to install systemd unit: ${
        err instanceof Error ? err.message : String(err)
      }`,
      exitCode: 1,
    };
  }
}

/**
 * Checks whether the running daemon was started before the current
 * dist/index.js was built. Returns a warning message if so, or null
 * if the daemon is up-to-date or not running.
 */
async function checkStaleDaemon(): Promise<string | null> {
  const paths = resolveHarnessPaths();
  const { getRunningDaemonPid } = await import("./process.js");
  const pid = await getRunningDaemonPid(paths.pidFile);
  if (pid === null) return null;

  // Get daemon start time from status
  let daemonStartISO: string | null = null;
  try {
    const resp = await sendIpcRequest(paths.socketFile, { type: "ping" }, 3_000);
    if (resp.type === "pong") {
      daemonStartISO = new Date(Date.now() - resp.uptime * 1000).toISOString();
    }
  } catch {
    return null; // Daemon unreachable
  }
  if (!daemonStartISO) return null;

  // Get dist build time
  const { stat } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const distPath = resolve(process.cwd(), "dist/index.js");
  try {
    const stats = await stat(distPath);
    const buildTime = stats.mtime;
    const daemonStart = new Date(daemonStartISO);
    if (daemonStart < buildTime) {
      return (
        `Running daemon (started ${daemonStart.toISOString()}) is older ` +
        `than the installed build (built ${buildTime.toISOString()}). ` +
        `Restart needed: harness daemon restart`
      );
    }
  } catch {
    // dist/index.js not found — can't compare
  }
  return null;
}

/* ─── daemon run (internal — the actual daemon process) ─── */

export async function daemonRun(): Promise<void> {
  const runtime = new DaemonRuntime();
  try {
    await runtime.start();
    // Log startup info to stderr (visible in foreground `daemon run`,
    // suppressed by stdio:"ignore" when spawned via `daemon start`).
    process.stderr.write(
      `[harness-daemon] PID ${process.pid} listening on ${runtime.getSocketPath()}\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[harness-daemon] Startup failed: ${msg}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  }
  // Block forever — the process exits via signal handlers calling
  // runtime.shutdown(), which calls process.exit(0).
  await new Promise<never>(() => {});
}

/* ─── harness sessions ─── */

export async function harnessSessions(): Promise<CliResult> {
  const paths = resolveHarnessPaths();
  try {
    const resp = await sendIpcRequest(paths.socketFile, { type: "list-sessions" });
    if (resp.type === "sessions-listed") {
      if (resp.sessions.length === 0) {
        return { stdout: "No sessions found.", exitCode: 0 };
      }
      const lines = resp.sessions.map((s) => {
        const date = s.createdAt.slice(0, 10);
        const mem = s.inMemory ? " ●" : "  ";
        return `${mem} ${s.sessionId} · ${date} · ${s.origin} · ${s.status} · ${s.turnsCompleted} turns`;
      });
      return { stdout: ["Sessions:", ...lines.map((l) => `  ${l}`)].join("\n"), exitCode: 0 };
    }
    if (resp.type === "error") {
      return { stdout: `Error: ${resp.message}`, exitCode: 1 };
    }
    return { stdout: `Unexpected response: ${resp.type}`, exitCode: 1 };
  } catch (err) {
    return {
      stdout: `Cannot reach daemon: ${err instanceof Error ? err.message : String(err)}\nIs the daemon running? Start it with: harness daemon start`,
      exitCode: 1,
    };
  }
}

/* ─── harness send ─── */

export async function harnessSend(
  message: string,
  sessionId?: string,
): Promise<CliResult> {
  const paths = resolveHarnessPaths();
  try {
    const resp = await sendIpcStreaming(
      paths.socketFile,
      { type: "submit-turn", text: message, sessionId },
      (event) => {
        if (event.type === "turn-event") {
          const ev = event.event;
          switch (ev.type) {
            case "token":
              process.stdout.write(ev.text);
              break;
            case "tool_call_start":
              process.stdout.write(`\n[tool: ${ev.name}]\n`);
              break;
            case "tool_call_done":
              // Truncate long results
              const result = ev.result.length > 200
                ? ev.result.substring(0, 200) + "..."
                : ev.result;
              process.stdout.write(`[tool result: ${result}]\n`);
              break;
            case "tool_call_error":
              process.stdout.write(`[tool error: ${ev.error}]\n`);
              break;
          }
        }
      },
    );

    if (resp.type === "turn-complete") {
      // If tokens were streamed, ensure a trailing newline
      process.stdout.write("\n");
      return { stdout: "", exitCode: 0 };
    }
    if (resp.type === "error") {
      return { stdout: `Error: ${resp.message}`, exitCode: 1 };
    }
    // Old daemon version — e.g. "turn-accepted" from pre-streaming protocol.
    return {
      stdout:
        `Received unexpected response from daemon: "${resp.type}".\n` +
        `This usually means the running daemon is older than your CLI.\n` +
        `Restart the daemon: harness daemon restart`,
      exitCode: 1,
    };
  } catch (err) {
    return {
      stdout: `Cannot reach daemon: ${err instanceof Error ? err.message : String(err)}\nIs the daemon running? Start it with: harness daemon start`,
      exitCode: 1,
    };
  }
}

/* ─── harness chat ─── */

export async function harnessChat(sessionId?: string): Promise<CliResult> {
  const paths = resolveHarnessPaths();

  // Verify daemon is reachable
  try {
    await sendIpcRequest(paths.socketFile, { type: "ping" }, 5_000);
  } catch (err) {
    return {
      stdout: `Cannot reach daemon: ${err instanceof Error ? err.message : String(err)}\nIs the daemon running? Start it with: harness daemon start`,
      exitCode: 1,
    };
  }

  // Create or resume session
  let activeSessionId = sessionId;
  if (!activeSessionId) {
    try {
      const resp = await sendIpcRequest(
        paths.socketFile,
        { type: "create-session", origin: "tui" },
        10_000,
      );
      if (resp.type === "session-created") {
        activeSessionId = resp.sessionId;
        console.log(`Session: ${activeSessionId}`);
      } else {
        return { stdout: `Failed to create session: ${JSON.stringify(resp)}`, exitCode: 1 };
      }
    } catch (err) {
      return {
        stdout: `Failed to create session: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      };
    }
  } else {
    // Resume existing session
    try {
      const resp = await sendIpcRequest(
        paths.socketFile,
        { type: "resume-session", sessionId: activeSessionId },
        10_000,
      );
      if (resp.type === "session-resumed") {
        console.log(`Resumed session: ${activeSessionId} (${resp.messageCount} messages)`);
      } else if (resp.type === "error") {
        return { stdout: `Failed to resume session: ${resp.message}`, exitCode: 1 };
      }
    } catch (err) {
      return {
        stdout: `Failed to resume session: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      };
    }
  }

  console.log(`Type your message. Ctrl+C to exit.\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  return new Promise<CliResult>((resolve) => {
    rl.prompt();

    rl.on("line", async (line: string) => {
      const text = line.trim();
      if (!text) {
        rl.prompt();
        return;
      }
      if (text === "/quit" || text === "/exit") {
        rl.close();
        resolve({ stdout: "Session ended.", exitCode: 0 });
        return;
      }

      try {
        await sendIpcStreaming(
          paths.socketFile,
          { type: "submit-turn", text, sessionId: activeSessionId },
          (event) => {
            if (event.type === "turn-event") {
              const ev = event.event;
              switch (ev.type) {
                case "token":
                  process.stdout.write(ev.text);
                  break;
                case "tool_call_start":
                  process.stdout.write(`\n[tool: ${ev.name}]\n`);
                  break;
                case "tool_call_done":
                  const result = ev.result.length > 200
                    ? ev.result.substring(0, 200) + "..."
                    : ev.result;
                  process.stdout.write(`[tool result: ${result}]\n`);
                  break;
                case "tool_call_error":
                  process.stdout.write(`[tool error: ${ev.error}]\n`);
                  break;
              }
            }
          },
        );

        process.stdout.write("\n\n");
        rl.prompt();
      } catch (err) {
        process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
        rl.prompt();
      }
    });

    rl.on("SIGINT", () => {
      rl.close();
      resolve({ stdout: "Session ended.", exitCode: 0 });
    });

    rl.on("close", () => {
      resolve({ stdout: "Session ended.", exitCode: 0 });
    });
  });
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
