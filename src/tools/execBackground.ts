import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { cwd } from "node:process";
import { EXEC_NO_FLY_PATTERNS, type ExecToolResult } from "./exec.js";
import { processSupervisor, type Session } from "./processSupervisor.js";
import { RingBuffer, generateHandle } from "./ringBuffer.js";

const MAX_OUTPUT_BYTES = 64 * 1024;

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

export async function executeExecBackground(args: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  elevated?: boolean;
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

  const handle = generateHandle();
  const stdoutRing = new RingBuffer(MAX_OUTPUT_BYTES);
  const stderrRing = new RingBuffer(MAX_OUTPUT_BYTES);

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutRing.append(chunk);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrRing.append(chunk);
  });

  const session: Session = {
    handle,
    pid: child.pid ?? -1,
    command: args.command,
    startedAt: new Date(),
    cwd: resolvedCwd,
    isPty: false,
    isElevated: args.elevated ?? false,
    child,
    stdoutRing,
    stderrRing,
  };

  processSupervisor.register(session);

  return {
    isError: false,
    content: `Background process started.\nhandle: ${handle}\npid: ${child.pid ?? -1}\ncommand: ${args.command}`,
  };
}
