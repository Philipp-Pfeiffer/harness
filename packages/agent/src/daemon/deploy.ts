import { spawn, execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { access } from "node:fs/promises";

/**
 * Self-deploy helpers: local merge of a branch into main plus build/test.
 *
 * NEVER runs an external `git fetch` — the branch must already exist
 * locally. All git operations are confined to `repoDir` (never the
 * state/home dir) and never touch the currently running daemon.
 */

/** Log sink signature matching the daemon's structured logger. */
export type DeployLog = (
  msg: string,
  level?: "info" | "warn" | "error",
  data?: Record<string, unknown>,
) => void;

/** Convenience: structured info log entry for the deploy flow. */
function logInfo(
  log: DeployLog,
  msg: string,
  data: Record<string, unknown>,
): void {
  log(msg, "info", data);
}

function logWarn(
  log: DeployLog,
  msg: string,
  data?: Record<string, unknown>,
): void {
  log(msg, "warn", data);
}

/** Timeout for the whole build+test step (10 minutes). */
export const DEPLOY_TIMEOUT_MS = 10 * 60 * 1_000;

/** Exit codes the deploy script uses to signal the daemon. */
export const SAFE_DEPLOY_EXIT = {
  /** Deploy prepared (merged + built + tested), restart required. */
  OK: 0,
  /** Conflict or validation error — main untouched. */
  CONFLICT: 1,
  /** Merge succeeded but build/test failed — main restored to previous HEAD. */
  BUILD_FAILED: 2,
} as const;

/** Results of a deploy attempt, reported back to the requesting channel. */
export interface DeployResult {
  /** Whether the deploy is prepared and a restart should happen. */
  ok: boolean;
  /** Message shown to the user (error detail on failure, otherwise summary). */
  message: string;
  /** New HEAD of main after a successful merge. */
  gitHead?: string;
}

export interface RepoInfo {
  /** Absolute path to the git repository root. */
  repoDir: string;
  /** Current HEAD of main (short hash), used for the restart marker. */
  currentHead: string;
  /** Whether main is in a clean working-tree state. */
  clean: boolean;
}

/** Reads HEAD of `main` in the repo and whether the working tree is clean. */
export async function readRepoInfo(repoDir: string): Promise<RepoInfo> {
  const [head, status] = await Promise.all([
    execGit(repoDir, ["rev-parse", "--short", "HEAD"]),
    execGit(repoDir, ["status", "--porcelain"]),
  ]);
  return {
    repoDir,
    currentHead: head.stdout.trim() || "unknown",
    clean: status.stdout.trim().length === 0,
  };
}

/**
 * Deploys `<branch>` to main.
 *
 * Contract for scripts/safe-deploy.sh (when present):
 *   $ scripts/safe-deploy.sh <branch>
 *   - Arguments: exactly one, the branch to merge into main.
 *   - Exit 0:   main fast-forwarded/merged, build+test passed, ready to restart.
 *   - Exit 1:   conflict/validation error — main untouched, nothing to roll back.
 *   - Exit 2:   merge done but build/test failed — main restored to previous HEAD.
 *   - Any other exit code: treated as BUILD_FAILED (attempt rollback).
 *   - The script does the git work (merge/fast-forward, rollback on failure,
 *     build, typecheck, test) and may write to the daemon log (streamed).
 *   - The daemon owns the restart marker, the /deploy lock, the
 *     "Deploy prepared, restarting…" response, and the actual restart.
 *   - Working directory is the repo root. Output is streamed to the daemon log.
 *   - Must never touch the running daemon process or $HARNESS_STATE.
 *
 * When the script is absent, the same contract is implemented inline.
 */
export async function runDeploy(
  repoDir: string,
  branch: string,
  log: DeployLog,
  opts?: { timeoutMs?: number },
): Promise<DeployResult> {
  const scriptPath = join(repoDir, "scripts", "safe-deploy.sh");
  if (await exists(scriptPath)) {
    const result = await runScriptDeploy(scriptPath, branch, log, opts);
    if (result.ok || result.rollbackAttempted) return result;
    // Exit code 1: conflict/validation — main untouched, report as-is.
    return { ok: false, message: result.message };
  }
  return runInlineDeploy(repoDir, branch, log, opts);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Result of the script path, with rollback already performed by the script. */
interface ScriptDeployResult {
  ok: boolean;
  rollbackAttempted: boolean;
  message: string;
  gitHead?: string;
}

async function runScriptDeploy(
  scriptPath: string,
  branch: string,
  log: DeployLog,
  opts?: { timeoutMs?: number },
): Promise<ScriptDeployResult> {
  const timeoutMs = opts?.timeoutMs ?? DEPLOY_TIMEOUT_MS;
  logInfo(log, "safe-deploy.sh found — delegating deploy to script", {
    script: scriptPath,
  });
  const exitCode = await runProcess(scriptPath, [branch], log, timeoutMs);
  if (exitCode === SAFE_DEPLOY_EXIT.OK) {
    const head = await execGit(repoDirOf(scriptPath), ["rev-parse", "--short", "HEAD"]);
    return {
      ok: true,
      rollbackAttempted: false,
      message: "Deploy prepared.",
      gitHead: head.stdout.trim(),
    };
  }
  if (exitCode === SAFE_DEPLOY_EXIT.CONFLICT) {
    return {
      ok: false,
      rollbackAttempted: false,
      message: `Deploy aborted: conflict or validation error for branch. Check the daemon log for details.`,
    };
  }
  return {
    ok: false,
    rollbackAttempted: true,
    message: `Deploy failed (script exit ${exitCode}). Main restored to previous HEAD.`,
  };
}

/** Finds the repo root from the script path (repo/scripts/safe-deploy.sh). */
function repoDirOf(scriptPath: string): string {
  return dirname(dirname(scriptPath));
}

async function runInlineDeploy(
  repoDir: string,
  branch: string,
  log: DeployLog,
  opts?: { timeoutMs?: number },
): Promise<DeployResult> {
  const timeoutMs = opts?.timeoutMs ?? DEPLOY_TIMEOUT_MS;
  const previousHead = (
    await execGit(repoDir, ["rev-parse", "--short", "HEAD"])
  ).stdout.trim();

  // (a) Verify the branch exists locally, then merge/fast-forward into main.
  //     No fetch — branches must exist locally. On conflict: abort, error out.
  try {
    const branchList = await execGit(repoDir, ["for-each-ref", `refs/heads/${branch}`]);
    if (!branchList.stdout.trim()) {
      return { ok: false, message: `Branch "${branch}" not found locally.` };
    }
    logInfo(log, "deploy: merging branch into main", {
      branch,
      from: previousHead,
    });
    await execGit(repoDir, ["merge", "--no-edit", branch]);
  } catch (err) {
    logWarn(log, "deploy: merge failed", { error: errMessage(err) });
    return {
      ok: false,
      message: `Deploy aborted: merge of "${branch}" into main failed (conflict?). Main was not changed.`,
    };
  }

  // (b) Install, build, typecheck, test — streamed into the daemon log.
  try {
    const commands: Array<[string, string[]]> = [
      ["pnpm", ["install"]],
      ["pnpm", ["build"]],
      ["pnpm", ["typecheck"]],
      ["pnpm", ["--filter", "@harness/agent", "test"]],
    ];
    for (const [cmd, args] of commands) {
      logInfo(log, "deploy: running", { cmd, args: args.join(" ") });
      const code = await runProcess(cmd, args, log, timeoutMs);
      if (code !== 0) {
        throw new Error(`"${cmd} ${args.join(" ")}" exited with code ${code}`);
      }
    }
  } catch (err) {
    logWarn(log, "deploy: build/test failed — restoring main", {
      error: errMessage(err),
    });
    try {
      await execGit(repoDir, ["reset", "--hard", previousHead]);
      await execGit(repoDir, ["clean", "-fdq"]);
    } catch (resetErr) {
      logWarn(log, "deploy: rollback failed", { error: errMessage(resetErr) });
      return {
        ok: false,
        message: `Deploy failed AND rollback failed. Manual intervention required. Error: ${errMessage(err)}`,
      };
    }
    return {
      ok: false,
      message: `Deploy failed: build or test errored. Main reset to ${previousHead}. Error: ${errMessage(err)}`,
    };
  }

  const newHead = (
    await execGit(repoDir, ["rev-parse", "--short", "HEAD"])
  ).stdout.trim();
  logInfo(log, "deploy: prepared", { branch, newHead });
  return { ok: true, message: "Deploy prepared.", gitHead: newHead };
}

/** Runs a command, streaming stdout/stderr into the daemon log. Returns exit code. */
async function runProcess(
  cmd: string,
  args: string[],
  log: DeployLog,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
      logWarn(log, `deploy: command timed out after ${Math.round(timeoutMs / 1000)}s`);
      resolve(124);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      logInfo(log, `[${cmd}] ${chunk.toString().trimEnd()}`, {});
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      logWarn(log, `[${cmd}] ${chunk.toString().trimEnd()}`);
    });
    child.on("error", (err) => {
      logWarn(log, `deploy: failed to spawn "${cmd}"`, { error: errMessage(err) });
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(1);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/** Runs a git command, streaming nothing. Throws on non-zero exit. */
async function execGit(
  repoDir: string,
  args: string[],
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", repoDir, ...args],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(
            new Error(
              `git ${args.join(" ")} failed: ${errMessage(err)}${stdout ? `\n${stdout}` : ""}`,
            ),
          );
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
