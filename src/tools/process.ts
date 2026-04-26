import { Type } from "@sinclair/typebox";
import { Value } from "typebox/value";
import type { Tool } from "./types.js";
import { processSupervisor } from "./processSupervisor.js";

export const ProcessArgs = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("poll"),
    Type.Literal("kill"),
    Type.Literal("log"),
    Type.Literal("wait"),
  ]),
  sessionId: Type.Optional(
    Type.String({
      pattern: "^bg_[a-f0-9]{8}$",
      description: "Handle of background session (e.g. bg_a3f29c8d)",
    })
  ),
  signal: Type.Optional(
    Type.Union([
      Type.Literal("SIGTERM"),
      Type.Literal("SIGKILL"),
      Type.Literal("SIGINT"),
    ])
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Byte offset for log pagination",
    })
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 64_000,
      description: "Max bytes to read from log",
    })
  ),
  timeout: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 120_000,
      description: "Timeout in ms for wait action (0 = poll once)",
    })
  ),
});

type ProcessArgsType = {
  action: "list" | "poll" | "kill" | "log" | "wait";
  sessionId?: string;
  signal?: "SIGTERM" | "SIGKILL" | "SIGINT";
  offset?: number;
  limit?: number;
  timeout?: number;
};

function formatAge(startedAt: Date, endedAt?: Date): string {
  const end = endedAt ?? new Date();
  const diffMs = end.getTime() - startedAt.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

export interface ProcessToolResult {
  isError: boolean;
  content: string;
}

export async function executeProcess(args: ProcessArgsType): Promise<ProcessToolResult> {
  if (!Value.Check(ProcessArgs, args)) {
    const errors = Array.from(Value.Errors(ProcessArgs, args));
    const msg = errors
      .map((e: { instancePath?: string; message?: string }) => `${e.instancePath || ""}: ${e.message || "validation failed"}`)
      .join("; ");
    return { isError: true, content: `Invalid arguments: ${msg}` };
  }

  switch (args.action) {
    case "list":
      return handleList();
    case "poll":
      if (!args.sessionId) {
        return { isError: true, content: "sessionId required for poll" };
      }
      return handlePoll(args.sessionId);
    case "kill":
      if (!args.sessionId) {
        return { isError: true, content: "sessionId required for kill" };
      }
      return handleKill(args.sessionId, args.signal ?? "SIGTERM");
    case "log":
      if (!args.sessionId) {
        return { isError: true, content: "sessionId required for log" };
      }
      return handleLog(args.sessionId, args.offset ?? 0, args.limit ?? 16_384);
    case "wait":
      if (!args.sessionId) {
        return { isError: true, content: "sessionId required for wait" };
      }
      return handleWait(args.sessionId, args.timeout ?? 30_000);
    default:
      return { isError: true, content: `Unknown action: ${args.action}` };
  }
}

function handleList(): ProcessToolResult {
  const { running, finished } = processSupervisor.list();

  const lines: string[] = [];

  if (running.length > 0) {
    lines.push("--- running ---");
    for (const session of running) {
      lines.push(
        `handle: ${session.handle}  pid: ${session.pid}  cmd: ${session.command}  started: ${formatTimestamp(session.startedAt)}  age: ${formatAge(session.startedAt)}`
      );
    }
  }

  if (finished.length > 0) {
    lines.push("--- finished ---");
    for (const session of finished) {
      lines.push(
        `handle: ${session.handle}  pid: -      cmd: ${session.command}  ended: ${formatTimestamp(session.exitedAt!)}   exit: ${session.exitCode ?? "null"}  age: ${formatAge(session.startedAt, session.exitedAt)}`
      );
    }
  }

  if (lines.length === 0) {
    return { isError: false, content: "No background sessions." };
  }

  return { isError: false, content: lines.join("\n") };
}

function handlePoll(sessionId: string): ProcessToolResult {
  const session = processSupervisor.get(sessionId);
  if (!session) {
    return { isError: true, content: `Session ${sessionId} not found or expired.` };
  }

  const { stdout, stderr } = processSupervisor.pollOutput(sessionId, 4096);

  const lines: string[] = [];
  lines.push(`--- session ${sessionId} ---`);
  lines.push(`state: ${session.exitedAt ? "finished" : "running"}`);
  lines.push(`pid: ${session.pid}`);
  lines.push(`command: ${session.command}`);
  lines.push(`started: ${formatTimestamp(session.startedAt)}`);

  if (session.exitedAt) {
    lines.push(`ended: ${formatTimestamp(session.exitedAt)}`);
    lines.push(`duration: ${formatAge(session.startedAt, session.exitedAt)}`);
    lines.push(`exit code: ${session.exitCode ?? "null"}`);
    lines.push(`exit signal: ${session.exitSignal ?? "null"}`);
  } else {
    lines.push(`duration: ${formatAge(session.startedAt)}`);
  }

  if (stdout) {
    lines.push("--- recent stdout (last 4 KB) ---");
    lines.push(stdout);
  }

  if (stderr) {
    lines.push("--- recent stderr (last 4 KB) ---");
    lines.push(stderr);
  }

  return { isError: false, content: lines.join("\n") };
}

async function handleKill(sessionId: string, signal: string): Promise<ProcessToolResult> {
  const session = processSupervisor.get(sessionId);
  if (!session) {
    return { isError: true, content: `Session ${sessionId} not found or expired.` };
  }

  const result = await processSupervisor.kill(sessionId, signal);

  const lines: string[] = [];
  lines.push(`--- killed ${sessionId} ---`);
  lines.push(`signal sent: ${signal}`);
  lines.push(`exit code: ${result.exitCode ?? "null"}`);
  lines.push(`exit signal: ${result.exitSignal ?? "null"}`);

  return { isError: false, content: lines.join("\n") };
}

function handleLog(sessionId: string, offset: number, limit: number): ProcessToolResult {
  const session = processSupervisor.get(sessionId);
  if (!session) {
    return { isError: true, content: `Session ${sessionId} not found or expired.` };
  }

  const { stdout, stderr, totalBytes, truncated } = processSupervisor.log(sessionId, offset, limit);

  const lines: string[] = [];
  lines.push(`--- log ${sessionId} ---`);
  lines.push(`offset: ${offset}  limit: ${limit}  total_bytes: ${totalBytes}  truncated: ${truncated}`);

  lines.push("--- stdout ---");
  lines.push(stdout || "(empty)");

  if (!session.isPty) {
    lines.push("--- stderr ---");
    lines.push(stderr || "(empty)");
  }

  return { isError: false, content: lines.join("\n") };
}

async function handleWait(sessionId: string, timeoutMs: number): Promise<ProcessToolResult> {
  const session = await processSupervisor.wait(sessionId, timeoutMs);

  if (!session) {
    const currentSession = processSupervisor.get(sessionId);
    if (!currentSession) {
      return { isError: true, content: `Session ${sessionId} not found or expired.` };
    }
    return {
      isError: false,
      content: `--- session ${sessionId} ---\nstate: running\npid: ${currentSession.pid}\ncommand: ${currentSession.command}\nstarted: ${formatTimestamp(currentSession.startedAt)}\nduration: ${formatAge(currentSession.startedAt)}\nstill running (timeout after ${timeoutMs}ms)`,
    };
  }

  const { stdout, stderr } = processSupervisor.pollOutput(sessionId, 64 * 1024);

  return {
    isError: false,
    content: `--- session ${sessionId} ---\nstate: finished\npid: ${session.pid}\ncommand: ${session.command}\nstarted: ${formatTimestamp(session.startedAt)}\nended: ${formatTimestamp(session.exitedAt!)}\nduration: ${formatAge(session.startedAt, session.exitedAt)}\nexit code: ${session.exitCode ?? "null"}\nexit signal: ${session.exitSignal ?? "null"}\n--- stdout ---\n${stdout || "(empty)"}\n--- stderr ---\n${stderr || "(empty)"}`,
  };
}

export const processTool: Tool<typeof ProcessArgs> = {
  name: "process",
  description:
    "Manage background processes started by exec. Actions: list all sessions, poll current state, kill running session, read paginated output log, wait for completion.",
  parameters: ProcessArgs,
  async execute(args) {
    const result = await executeProcess(args);
    return result.content;
  },
};
