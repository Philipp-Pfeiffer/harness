import * as pty from "node-pty";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { cwd } from "node:process";
import { existsSync, statSync } from "node:fs";
import { EXEC_NO_FLY_PATTERNS, type ExecToolResult } from "./exec.js";
import { processSupervisor } from "./processSupervisor.js";
import { RingBuffer, generateHandle } from "./ringBuffer.js";
import { BG_OUTPUT_CAP } from "./limits.js";
import type { Session } from "./processSupervisor.js";


const KILL_GRACE_MS = 5_000;

function resolveShell(): string {
  const candidates = ["/bin/bash", "/usr/bin/bash", "/bin/sh"];
  for (const shell of candidates) {
    try {
      if (existsSync(shell)) {
        const stats = statSync(shell);
        if (stats.isFile() && (stats.mode & 0o111) !== 0) {
          return shell;
        }
      }
    } catch (_) {
      // continue to next candidate
    }
  }
  throw new Error(`No suitable shell found (tried: ${candidates.join(", ")})`);
}

let cachedShellPath: string | undefined;

function getShellPath(): { ok: true; path: string } | { ok: false; error: string } {
  if (cachedShellPath !== undefined) {
    return { ok: true, path: cachedShellPath };
  }
  try {
    const path = resolveShell();
    cachedShellPath = path;
    return { ok: true, path };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to resolve shell: ${message}` };
  }
}

function expandTilde(pathStr: string): string {
  if (pathStr.startsWith("~/") || pathStr === "~") {
    return pathStr.replace(/^~/, homedir());
  }
  return pathStr;
}

function checkNoFly(command: string): { blocked: true; message: string } | { blocked: false } {
  for (const { pattern, reason, hint } of EXEC_NO_FLY_PATTERNS) {
    if (pattern.test(command)) {
      const msg = hint
        ? `Blocked destructive command: ${reason}. ${hint}`
        : `Blocked destructive command: ${reason}.`;
      return { blocked: true, message: `${msg}\nIf you really need this, the user must run it manually.` };
    }
  }
  return { blocked: false };
}

async function resolveCwd(cwdArg?: string): Promise<string> {
  let resolvedCwd = cwd();
  if (cwdArg) {
    const expanded = expandTilde(cwdArg);
    resolvedCwd = resolve(cwd(), expanded);
    try {
      const statResult = await import("node:fs/promises").then((fs) => fs.stat(resolvedCwd));
      if (!statResult.isDirectory()) {
        return "cwd does not exist or is not a directory";
      }
    } catch {
      return "cwd does not exist or is not a directory";
    }
  }
  return resolvedCwd;
}

export async function executeExecPty(args: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  elevated?: boolean;
  timeout?: number;
  yieldMs?: number;
}): Promise<ExecToolResult> {
  const resolvedCwdResult = await resolveCwd(args.cwd);
  if (resolvedCwdResult === "cwd does not exist or is not a directory") {
    return { isError: true, content: "cwd does not exist or is not a directory" };
  }
  const resolvedCwd = resolvedCwdResult;

  const noFlyCheck = checkNoFly(args.command);
  if (noFlyCheck.blocked) {
    return { isError: true, content: noFlyCheck.message };
  }

  const shellResult = getShellPath();
  if (!shellResult.ok) {
    return { isError: true, content: shellResult.error };
  }
  const shellPath = shellResult.path;

  const mergedEnv = args.env ? { ...process.env, ...args.env } : process.env;
  const finalCommand = args.elevated ? `sudo -n ${args.command}` : args.command;
  const timeoutMs = args.timeout ?? 30_000;

  if (shellPath === "/bin/sh") {
    console.warn("[execPty] Warning: falling back to /bin/sh. Bash-specific syntax may fail.");
  }

  const ptyProc = pty.spawn(shellPath, ["-c", finalCommand], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env: mergedEnv,
  });

  const chunks: Buffer[] = [];
  let totalSize = 0;
  let truncated = false;
  let yielded = false;

  ptyProc.onData((data: string) => {
    if (truncated) return;
    if (yielded) {
      const session = processSupervisor.get(
        `bg_${ptyProc.pid.toString(16).padStart(8, "0").slice(0, 8)}`
      );
      if (session) {
        session.stdoutRing.append(Buffer.from(data, "utf-8"));
      }
      return;
    }
    const chunk = Buffer.from(data, "utf-8");
    if (totalSize + chunk.length > BG_OUTPUT_CAP) {
      const remaining = BG_OUTPUT_CAP - totalSize;
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        totalSize += remaining;
      }
      truncated = true;
    } else {
      chunks.push(chunk);
      totalSize += chunk.length;
    }
  });

  return new Promise((resolvePromise) => {
    let exitCode: number | null = null;
    let signal: number | null | undefined = undefined;
    let killed = false;
    let timedOut = false;

    const cleanup = () => {
      if (!killed) {
        try {
          ptyProc.kill("SIGTERM");
        } catch (_) {}
        killed = true;
        timedOut = true;
        setTimeout(() => {
          if (exitCode === null && signal === null) {
            try {
              ptyProc.kill("SIGKILL");
            } catch (_) {}
          }
        }, KILL_GRACE_MS);
      }
    };

    const timeoutId = setTimeout(() => {
      cleanup();
    }, timeoutMs);

    ptyProc.onExit(({ exitCode: code, signal: sig }) => {
      exitCode = code;
      signal = sig;
      clearTimeout(timeoutId);
    });

    const handleYield = () => {
      if (exitCode !== null || signal !== undefined) return;

      yielded = true;
      const handle = generateHandle();
      const pid = ptyProc.pid;
      const session: Session = {
        handle,
        pid,
        command: args.command,
        startedAt: new Date(),
        cwd: resolvedCwd,
        isPty: true,
        isElevated: args.elevated ?? false,
        child: ptyProc,
        stdoutRing: new RingBuffer(BG_OUTPUT_CAP),
        stderrRing: new RingBuffer(BG_OUTPUT_CAP),
      };

      for (const chunk of chunks) {
        session.stdoutRing.append(chunk);
      }

      processSupervisor.register(session);
      resolvePromise({
        isError: false,
        content: `Background process started.\nhandle: ${handle}\npid: ${pid}\ncommand: ${args.command}`,
      });
    };

    if (args.yieldMs && args.yieldMs > 0) {
      setTimeout(handleYield, args.yieldMs);
    }

    const resolveOutput = () => {
      if (yielded) {
        return;
      }

      const output = Buffer.concat(chunks).toString("utf-8");
      const truncatedNote = truncated
        ? `\n[...truncated, original size approx ${totalSize} bytes]`
        : "";
      const isError = exitCode !== 0 || signal !== null;

      let content = `--- output ---\n${output || "(empty)"}\n--- exit ---\ncode: ${exitCode ?? "null"}, signal: ${signal ?? "null"}${truncatedNote}`;
      if (timedOut) {
        content = `Command timed out after ${timeoutMs / 1000}s and was terminated.\n${content}`;
      }

      resolvePromise({
        isError,
        content,
      });
    };

    ptyProc.onExit(() => {
      setImmediate(resolveOutput);
    });
  });
}
