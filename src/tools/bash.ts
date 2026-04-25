import { Type } from "@sinclair/typebox";
import { Value } from "typebox/value";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { cwd } from "node:process";
import type { Tool } from "./types.js";

export const BashArgs = Type.Object({
  command: Type.String({ description: "Bash command to execute. Pipes, redirects, globs are supported.", minLength: 1 }),
  cwd: Type.Optional(Type.String({ description: "Working directory. Default: process.cwd(). Absolute or relative path; supports ~." })),
});

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const KILL_GRACE_MS = 5000;

export const BASH_NO_FLY_PATTERNS: { pattern: RegExp; reason: string; hint?: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s|-[rRfF]\s+-[fFrR]\s)/, reason: "rm with -rf/-fr/-Rf is blocked", hint: "Use 'trash' (trash-cli) for safe file deletion." },
  { pattern: /\bdd\s+if=/, reason: "dd with input file is blocked (can destroy disks)" },
  { pattern: /\bmkfs\b/, reason: "mkfs.* is blocked (filesystem format)" },
  { pattern: />\s*\/dev\/(sd|nvme|hd)/, reason: "Direct write to disk device is blocked" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Fork bomb pattern blocked" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "System power command blocked" },
  { pattern: /\bkill\s+-(9|KILL)\s+1\b/, reason: "Killing init (PID 1) is blocked" },
  { pattern: /\bchmod\s+-R\s+0*0+\s+\//, reason: "Recursive chmod 000 on root is blocked" },
];

function expandTilde(pathStr: string): string {
  if (pathStr.startsWith("~/") || pathStr === "~") {
    return pathStr.replace(/^~/, homedir());
  }
  return pathStr;
}

function checkNoFly(command: string): { blocked: true; message: string } | { blocked: false } {
  for (const { pattern, reason, hint } of BASH_NO_FLY_PATTERNS) {
    if (pattern.test(command)) {
      const msg = hint ? `Blocked destructive command: ${reason}. ${hint}` : `Blocked destructive command: ${reason}.`;
      return { blocked: true, message: `${msg}\nIf you really need this, the user must run it manually.` };
    }
  }
  return { blocked: false };
}

export interface BashToolResult {
  isError: boolean;
  content: string;
}

function formatOutput(stdout: string, stderr: string, exitCode: number | null, signal: string | null, truncated?: boolean, originalSize?: number): string {
  const truncatedNote = truncated ? `\n[...truncated, original size approx ${originalSize} bytes]` : "";
  return `--- stdout ---\n${stdout || "(empty)"}\n--- stderr ---\n${stderr || "(empty)"}\n--- exit ---\ncode: ${exitCode ?? "null"}, signal: ${signal ?? "null"}${truncatedNote}`;
}

export async function executeBash(
  args: { command: string; cwd?: string },
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<BashToolResult> {
  if (!Value.Check(BashArgs, args)) {
    const errors = Array.from(Value.Errors(BashArgs, args));
    const msg = errors.map((e: { instancePath?: string; message?: string }) => `${e.instancePath || ""}: ${e.message || "validation failed"}`).join("; ");
    return { isError: true, content: `Invalid arguments: ${msg}` };
  }

  let resolvedCwd = cwd();
  if (args.cwd) {
    const expanded = expandTilde(args.cwd);
    resolvedCwd = resolve(cwd(), expanded);
    try {
      const statResult = await import("node:fs/promises").then(fs => fs.stat(resolvedCwd));
      if (!statResult.isDirectory()) {
        return { isError: true, content: "cwd does not exist or is not a directory" };
      }
    } catch {
      return { isError: true, content: "cwd does not exist or is not a directory" };
    }
  }

  const noFlyCheck = checkNoFly(args.command);
  if (noFlyCheck.blocked) {
    return { isError: true, content: noFlyCheck.message };
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(args.command, [], { shell: true, detached: true, cwd: resolvedCwd });
  } catch (err) {
    return { isError: true, content: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}` };
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
    if (stdoutSize + stderrSize + chunkSize > MAX_OUTPUT_BYTES) {
      const remaining = MAX_OUTPUT_BYTES - (stdoutSize + stderrSize);
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
    if (stdoutSize + stderrSize + chunkSize > MAX_OUTPUT_BYTES) {
      const remaining = MAX_OUTPUT_BYTES - (stdoutSize + stderrSize);
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
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (_) {}
      killed = true;
    }
  };

  const getOutput = () => {
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    const stderr = Buffer.concat(stderrChunks).toString("utf-8");
    return { stdout, stderr };
  };

  return new Promise((resolve) => {
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
      resolve({
        isError: true,
        content: `Process error: ${err.message}`,
      });
    });

    child.on("exit", () => {
      clearTimeout(timeoutId);
      cleanup();
      if (timedOut) {
        const { stdout, stderr } = getOutput();
        resolve({
          isError: true,
          content: `Command timed out after ${timeoutMs / 1000}s and was terminated.\n${formatOutput(stdout, stderr, exitCode, signal, truncated)}`,
        });
      } else {
        const { stdout, stderr } = getOutput();
        resolve({
          isError: false,
          content: formatOutput(stdout, stderr, exitCode, signal, truncated),
        });
      }
    });

    setTimeout(() => {
      if (exitCode === null && signal === null) {
        cleanup();
        const { stdout, stderr } = getOutput();
        resolve({
          isError: true,
          content: `Command timed out after ${timeoutMs / 1000}s and was terminated.\n${formatOutput(stdout, stderr, exitCode, signal, truncated)}`,
        });
      }
    }, timeoutMs + KILL_GRACE_MS + 200);
  });
}

export const bashTool: Tool<typeof BashArgs> = {
  name: "bash",
  description: "Execute a bash command via shell. Supports pipes, redirects, globs. Returns combined stdout+stderr with exit code. Default timeout 30s, output capped at 64 KB. Some destructive commands (e.g. 'rm -rf') are blocked.",
  parameters: BashArgs,
  async execute(args) {
    const result = await executeBash(args);
    return result.content;
  },
};