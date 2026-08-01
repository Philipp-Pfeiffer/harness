import { Type } from "@sinclair/typebox";
import { Value } from "typebox/value";
import { spawn } from "node:child_process";
import type { Tool } from "./types.js";
import type { ToolResult } from "./types.js";
import { checkNoFly, resolveCwd } from "./path_util.js";
import { executeExecPty } from "./execPty.js";
import { executeExecBackground } from "./execBackground.js";
import { processSupervisor } from "./processSupervisor.js";
import { RingBuffer, generateHandle } from "./ringBuffer.js";
import { SYNC_OUTPUT_CAP, BG_OUTPUT_CAP } from "./limits.js";
import type { Session } from "./processSupervisor.js";

export const ExecArgs = Type.Object({
  command: Type.String({
    minLength: 1,
    description: "CLI command to execute. Supports pipes, redirects, globs, and arbitrary shell syntax.",
  }),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory. Must exist. Supports ~ for home directory. Default: process.cwd().",
    })
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Environment variables merged onto process.env. Existing keys are overridden.",
    })
  ),
  stdin: Type.Optional(
    Type.String({
      description:
        "String piped to child stdin once, then closed. Not usable with pty:true in Phase 1.",
    })
  ),
  timeout: Type.Optional(
    Type.Integer({
      minimum: 100,
      maximum: 3_600_000,
      default: 30_000,
      description:
        "Timeout in milliseconds. After timeout: SIGTERM, 5s grace period, then SIGKILL. Default: 30000.",
    })
  ),
  pty: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Run via PTY for interactive CLIs (vim, htop, claude, gemini, codex). Merges stdout+stderr, preserves ANSI codes.",
    })
  ),
  elevated: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Prefix command with sudo -n. Requires passwordless sudo; fails otherwise.",
    })
  ),
  background: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Start detached, return handle immediately.",
    })
  ),
  yieldMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 600_000,
      default: 10_000,
      description:
        "Wait this many ms; if process still alive, transition to background and return handle. Default: 10000.",
    })
  ),
});

type ExecArgsType = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeout?: number;
  pty?: boolean;
  elevated?: boolean;
  background?: boolean;
  yieldMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;

export { EXEC_NO_FLY_PATTERNS } from "./path_util.js";

export interface ExecToolResult extends ToolResult {}

function formatOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  signal: string | null,
  truncated?: boolean,
  originalSize?: number
): string {
  const truncatedNote = truncated
    ? `\n[...truncated, original size approx ${originalSize} bytes]`
    : "";
  return `--- stdout ---\n${stdout || "(empty)"}\n--- stderr ---\n${stderr || "(empty)"}\n--- exit ---\ncode: ${exitCode ?? "null"}, signal: ${signal ?? "null"}${truncatedNote}`;
}

export async function executeExecSync(args: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeout?: number;
  elevated?: boolean;
  abortSignal?: AbortSignal;
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

  const mergedEnv = args.env ? { ...process.env, ...args.env } : process.env;
  const finalCommand = args.elevated ? `sudo -n ${args.command}` : args.command;
  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(finalCommand, [], {
      shell: true,
      detached: true,
      cwd: resolvedCwd,
      env: mergedEnv,
    });
  } catch (err) {
    return {
      isError: true,
      content: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (args.stdin !== undefined) {
    child.stdin?.write(args.stdin);
    child.stdin?.end();
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  let truncated = false;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let killed = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    if (truncated) return;
    const chunkSize = chunk.length;
    if (stdoutSize + stderrSize + chunkSize > SYNC_OUTPUT_CAP) {
      const remaining = SYNC_OUTPUT_CAP - (stdoutSize + stderrSize);
      if (remaining > 0) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutSize += remaining;
      }
      truncated = true;
    } else {
      stdoutChunks.push(chunk);
      stdoutSize += chunkSize;
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (truncated) return;
    const chunkSize = chunk.length;
    if (stdoutSize + stderrSize + chunkSize > SYNC_OUTPUT_CAP) {
      const remaining = SYNC_OUTPUT_CAP - (stdoutSize + stderrSize);
      if (remaining > 0) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrSize += remaining;
      }
      truncated = true;
    } else {
      stderrChunks.push(chunk);
      stderrSize += chunkSize;
    }
  });

  const cleanup = () => {
    if (!killed && child.pid) {
      const pid = child.pid;
      try {
        process.kill(-pid, "SIGTERM");
      } catch (_) {}
      killed = true;
      setTimeout(() => {
        if (exitCode === null && signal === null) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (_) {}
        }
      }, KILL_GRACE_MS);
    }
  };

  const getOutput = () => {
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    const stderr = Buffer.concat(stderrChunks).toString("utf-8");
    return { stdout, stderr };
  };

  return new Promise((resolvePromise) => {
    let timedOut = false;
    let abortedByUser = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      cleanup();
    }, timeoutMs);

    const onUserAbort = () => {
      if (abortedByUser || timedOut) return;
      abortedByUser = true;
      cleanup();
    };
    if (args.abortSignal) {
      if (args.abortSignal.aborted) {
        onUserAbort();
      } else {
        args.abortSignal.addEventListener("abort", onUserAbort, { once: true });
      }
    }

    child.on("exit", (code, sig) => {
      exitCode = code;
      signal = sig;
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      args.abortSignal?.removeEventListener("abort", onUserAbort);
      cleanup();
      resolvePromise({
        isError: true,
        content: `Process error: ${err.message}`,
      });
    });

    child.on("exit", () => {
      clearTimeout(timeoutId);
      args.abortSignal?.removeEventListener("abort", onUserAbort);
      cleanup();
      if (abortedByUser) {
        const { stdout, stderr } = getOutput();
        resolvePromise({
          isError: true,
          content: `Command aborted by user.\n${formatOutput(stdout, stderr, exitCode, signal, truncated)}`,
        });
      } else if (timedOut) {
        const { stdout, stderr } = getOutput();
        resolvePromise({
          isError: true,
          content: `Command timed out after ${timeoutMs / 1000}s and was terminated.\n${formatOutput(stdout, stderr, exitCode, signal, truncated)}`,
        });
      } else {
        const { stdout, stderr } = getOutput();
        resolvePromise({
          isError: false,
          content: formatOutput(stdout, stderr, exitCode, signal, truncated),
        });
      }
    });
  });
}

function createSession(
  handle: string,
  pid: number,
  command: string,
  cwd: string,
  isPty: boolean,
  isElevated: boolean,
  child: ReturnType<typeof spawn>
): Session {
  const stdoutRing = new RingBuffer(BG_OUTPUT_CAP);
  const stderrRing = new RingBuffer(BG_OUTPUT_CAP);
  return {
    handle,
    pid,
    command,
    startedAt: new Date(),
    cwd,
    isPty,
    isElevated,
    child,
    stdoutRing,
    stderrRing,
  };
}

function transitionToBackground(
  session: Session,
  stdoutChunks: Buffer[],
  stderrChunks: Buffer[]
): string {
  for (const chunk of stdoutChunks) {
    session.stdoutRing.append(chunk);
  }
  for (const chunk of stderrChunks) {
    session.stderrRing.append(chunk);
  }
  processSupervisor.register(session);
  return `Background process started.\nhandle: ${session.handle}\npid: ${session.pid}\ncommand: ${session.command}`;
}

export async function executeExecSyncWithYield(args: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeout?: number;
  elevated?: boolean;
  yieldMs: number;
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

  const mergedEnv = args.env ? { ...process.env, ...args.env } : process.env;
  const finalCommand = args.elevated ? `sudo -n ${args.command}` : args.command;
  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(finalCommand, [], {
      shell: true,
      detached: true,
      cwd: resolvedCwd,
      env: mergedEnv,
    });
  } catch (err) {
    return {
      isError: true,
      content: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (args.stdin !== undefined) {
    child.stdin?.write(args.stdin);
    child.stdin?.end();
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let exitCode: number | null = null;
  let signal: string | null = null;
  let killed = false;
  let yielded = false;
  let childPid = child.pid ?? -1;
  // Holds the background session after yield transition, so the data
  // handlers can append directly to its ring buffers.
  let bgSession: Session | null = null;

  child.stdout?.on("data", (chunk: Buffer) => {
    if (!yielded) {
      stdoutChunks.push(chunk);
    } else if (bgSession) {
      bgSession.stdoutRing.append(chunk);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (!yielded) {
      stderrChunks.push(chunk);
    } else if (bgSession) {
      bgSession.stderrRing.append(chunk);
    }
  });

  const cleanup = () => {
    if (!killed && child.pid) {
      const pid = child.pid;
      try {
        process.kill(-pid, "SIGTERM");
      } catch (_) {}
      killed = true;
      setTimeout(() => {
        if (exitCode === null && signal === null) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (_) {}
        }
      }, KILL_GRACE_MS);
    }
  };

  return new Promise((resolvePromise) => {
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      cleanup();
    }, timeoutMs);

    child.on("exit", (code, sig) => {
      exitCode = code;
      signal = sig;
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      cleanup();
      resolvePromise({
        isError: true,
        content: `Process error: ${err.message}`,
      });
    });

    child.on("exit", () => {
      if (yielded) return;
      clearTimeout(timeoutId);
      cleanup();
      if (timedOut) {
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        resolvePromise({
          isError: true,
          content: `Command timed out after ${timeoutMs / 1000}s and was terminated.\n${formatOutput(stdout, stderr, exitCode, signal)}`,
        });
      } else {
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        resolvePromise({
          isError: false,
          content: formatOutput(stdout, stderr, exitCode, signal),
        });
      }
    });

    const yieldTimerId = setTimeout(() => {
      if (exitCode !== null || signal !== null) return;

      yielded = true;
      const handle = generateHandle();
      const session = createSession(
        handle,
        childPid,
        args.command,
        resolvedCwd,
        false,
        args.elevated ?? false,
        child
      );
      bgSession = session;
      const msg = transitionToBackground(session, stdoutChunks, stderrChunks);
      resolvePromise({
        isError: false,
        content: msg,
      });
    }, args.yieldMs);

    child.on("exit", () => {
      clearTimeout(yieldTimerId);
    });
  });
}

export async function executeExec(
  args: ExecArgsType,
  logger?: (msg: string, level?: "warn" | "debug") => void,
  abortSignal?: AbortSignal,
): Promise<ExecToolResult> {
  if (!Value.Check(ExecArgs, args)) {
    const errors = Array.from(Value.Errors(ExecArgs, args));
    const msg = errors
      .map((e: { instancePath?: string; message?: string }) => `${e.instancePath || ""}: ${e.message || "validation failed"}`)
      .join("; ");
    return { isError: true, content: `Invalid arguments: ${msg}` };
  }

  if (args.pty && args.stdin !== undefined) {
    return {
      isError: true,
      content: "stdin not supported with pty in Phase 1",
    };
  }

  if (args.background && args.stdin !== undefined) {
    return {
      isError: true,
      content: "stdin not supported with background in Phase 2",
    };
  }

  if (args.background) {
    return executeExecBackground(args);
  }

  if (args.yieldMs !== undefined) {
    if (args.pty) {
      return executeExecPty({ ...args, yieldMs: args.yieldMs }, logger);
    }
    return executeExecSyncWithYield({ ...args, yieldMs: args.yieldMs });
  }

  if (args.pty) {
    return executeExecPty({
      command: args.command,
      cwd: args.cwd,
      env: args.env,
      timeout: args.timeout,
      elevated: args.elevated,
    }, logger);
  }

  return executeExecSync({ ...args, abortSignal });
}

export const execTool: Tool<typeof ExecArgs> = {
  name: "exec",
  description:
    "Execute a CLI command. Supports pipes, redirects, globs, environment overrides, stdin, configurable timeout, PTY mode for interactive CLIs (vim, htop, claude, gemini, codex), and elevated execution via passwordless sudo. Returns combined output with exit code. Default timeout 30s, output capped at 64 KB. With yieldMs (default 10000), processes running longer than the yield threshold transition to background and return a handle for later polling. Some destructive commands (e.g. rm -rf /) are blocked.",
  parameters: ExecArgs,
  async execute(args, context) {
    return executeExec(args, context?.logger, context?.signal);
  },
};
