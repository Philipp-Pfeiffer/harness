import { spawn } from "node:child_process";

export interface GitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Minimal git wrapper: run a git command in `cwd` and capture stdout/stderr
 * + exit code. Never rejects — callers decide how to interpret the outcome.
 */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolve({ exitCode: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on("exit", (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
