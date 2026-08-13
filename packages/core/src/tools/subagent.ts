import { Type } from "@sinclair/typebox";
import type { Tool, ToolCallContext } from "./types.js";
import { ok, err } from "./types.js";

const SubagentArgs = Type.Object({
  action: Type.Union([
    Type.Literal("start"),
    Type.Literal("status"),
    Type.Literal("stop"),
  ], {
    description:
      "'start' launches a background sub-agent and returns immediately; 'status' polls a task; 'stop' aborts a task.",
  }),
  role: Type.String({
    minLength: 1,
    description: "Sub-agent persona + tool set. Known roles: coder.",
  }),
  task: Type.Optional(Type.String({
    minLength: 1,
    description:
      "Briefing for the sub-agent (required for action 'start'). MUST contain: goal, relevant files/code anchors (datei:zeile), verification commands, done criteria, and prohibitions (no push, no restart, no foreign worktrees).",
  })),
  repo: Type.Optional(Type.String({
    description:
      "Git repository to create an isolated worktree in (coder role only; other roles ignore it). Default: no worktree, the sub-agent runs in the daemon's cwd.",
  })),
  model: Type.Optional(Type.String({
    description: "Optional model override, e.g. 'provider/model-id' or '@preset/name'. Defaults to the role's model.",
  })),
  handle: Type.Optional(Type.String({
    minLength: 1,
    description: "Task id returned by a previous 'start' action (required for 'status'/'stop').",
  })),
});

type SubagentArgsType = {
  action: "start" | "status" | "stop";
  role: string;
  task?: string;
  repo?: string;
  model?: string;
  handle?: string;
};

const SUBAGENT_TOOL_DESCRIPTION = `Delegate a well-defined task to a dedicated background sub-agent and return immediately.

Use action: "start" with a "task" briefing to launch a background sub-agent. The
tool returns IMMEDIATELY with a task id — do NOT wait for the result. Tell the
user the task is running, then poll with action: "status" (with the id) later,
or let the completion event report back automatically. Use action: "stop" to
abort a running task. Max 2 sub-agents run concurrently.

Roles (persona + tool set + default model):
- coder: coding tasks in an isolated git worktree. Tools: readFile, write, edit, exec, process.
  Pass "repo" to create a worktree at <repo>-coder-<id> with branch coder/<slug> —
  the sub-agent commits there, never pushes, and never touches other worktrees.

## How to task well — the briefing is the quality lever
A good "task" MUST contain:
1. **Goal** — what to deliver, in one sentence.
2. **Relevant files/code anchors** — exact paths with datei:zeile line numbers; name the anchors to inspect first.
3. **Verification commands** — how to prove the work is done (tests, typecheck, build).
4. **Done criteria** — what "done" means, verifiable.
5. **Prohibitions** — no push, no restart of services, no edits outside the worktree, no reading of secret files.

Cheap models follow the briefing literally: the more precise it is, the better the result.

## Returns
start → { id, worktree?, branch? }. The completion event reports back the
sub-agent's final message (report) into the requesting chat.`;

export const subagentTool: Tool<typeof SubagentArgs> = {
  name: "subagent",
  description: SUBAGENT_TOOL_DESCRIPTION,
  parameters: SubagentArgs,
  conflictKey() {
    return "subagent";
  },
  async execute(args: SubagentArgsType, context?: ToolCallContext) {
    if (!context?.subagentRunner) {
      return err(
        "Kein Subagent-Runner verfügbar — das subagent-Tool ist nur im Daemon-Kontext aktiv.",
      );
    }

    switch (args.action) {
      case "start": {
        if (!args.task) {
          return err("task ist für action 'start' erforderlich.");
        }
        const result = await context.subagentRunner.start({
          role: args.role,
          task: args.task,
          repo: args.repo,
          model: args.model,
          requesterSessionId: context.sessionId,
        });
        if (!result.ok) {
          return err(result.error);
        }
        const location = result.worktree && result.branch
          ? ` Worktree: ${result.worktree} (Branch ${result.branch}).`
          : "";
        return ok(
          `Subagent gestartet (id: ${result.id}, Rolle: ${args.role}).${location} ` +
          `Poll mit action "status" und dieser id, oder warte auf das Completion-Event. ` +
          `Sage dem User, dass der Task läuft und du dich meldest.`,
        );
      }
      case "status": {
        if (!args.handle) {
          return err("handle ist für action 'status' erforderlich.");
        }
        const result = await context.subagentRunner.status(args.handle);
        return result.ok ? ok(result.text) : err(result.error);
      }
      case "stop": {
        if (!args.handle) {
          return err("handle ist für action 'stop' erforderlich.");
        }
        const result = await context.subagentRunner.stop(args.handle);
        return result.ok ? ok(result.text) : err(result.error);
      }
    }
  },
};
