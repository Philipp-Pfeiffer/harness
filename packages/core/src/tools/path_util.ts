import { homedir } from "node:os";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { stat } from "node:fs/promises";

export function expandTilde(pathStr: string): string {
  if (pathStr.startsWith("~/") || pathStr === "~") {
    return pathStr.replace(/^~/, homedir());
  }
  return pathStr;
}

export function resolveExpandedPath(pathStr: string): string {
  return resolve(expandTilde(pathStr));
}

export const EXEC_NO_FLY_PATTERNS: { pattern: RegExp; reason: string; hint?: string }[] = [
  {
    pattern: /\brm\b(?=\s+(--recursive\s+--force|--force\s+--recursive|-rf\b|-fr\b|-Rf\b|-fR\b|-[a-zA-Z]*[rR][a-zA-Z]*\s+-[a-zA-Z]*[fF]|-[a-zA-Z]*[fF][a-zA-Z]*\s+-[a-zA-Z]*[rR]))/,
    reason: "rm with -rf/-fr/-Rf is blocked",
    hint: "Use 'trash' (trash-cli) for safe file deletion.",
  },
  {
    pattern: /\brm\b(?=\s+(-[rR]\s+--force\b|--force\b\s+-[rR]|-[fF]\s+--recursive\b|--recursive\b\s+-[fF]))/,
    reason: "rm with mixed recursive+force flags is blocked",
    hint: "Use 'trash' (trash-cli) for safe file deletion.",
  },
  {
    pattern: /\bdd\s+if=/,
    reason: "dd with input file is blocked (can destroy disks)",
  },
  { pattern: /\bmkfs\b/, reason: "mkfs.* is blocked (filesystem format)" },
  {
    pattern: />\s*\/dev\/(sd|nvme|hd)/,
    reason: "Direct write to disk device is blocked",
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "Fork bomb pattern blocked",
  },
  {
    pattern: /\b(shutdown|reboot|halt|poweroff)\b/,
    reason: "System power command blocked",
  },
  { pattern: /\bkill\s+-(9|KILL)\s+1\b/, reason: "Killing init (PID 1) is blocked" },
  {
    pattern: /\bchmod\s+-R\s+0*0+\s+\//,
    reason: "Recursive chmod 000 on root is blocked",
  },
];

export function checkNoFly(command: string): { blocked: true; message: string } | { blocked: false } {
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

export async function resolveCwd(cwdArg?: string): Promise<string> {
  let resolvedCwd = cwd();
  if (cwdArg) {
    const expanded = expandTilde(cwdArg);
    resolvedCwd = resolve(cwd(), expanded);
    try {
      const statResult = await stat(resolvedCwd);
      if (!statResult.isDirectory()) {
        return "cwd does not exist or is not a directory";
      }
    } catch {
      return "cwd does not exist or is not a directory";
    }
  }
  return resolvedCwd;
}