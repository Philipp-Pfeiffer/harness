import { spawn } from "node:child_process";
import type { ExecToolResult } from "./exec.js";
import { checkNoFly, resolveCwd } from "./path_util.js";
import { processSupervisor, type Session } from "./processSupervisor.js";
import { RingBuffer, generateHandle } from "./ringBuffer.js";
import { BG_OUTPUT_CAP } from "./limits.js";



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
  const stdoutRing = new RingBuffer(BG_OUTPUT_CAP);
  const stderrRing = new RingBuffer(BG_OUTPUT_CAP);

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
