import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Message } from "@mariozechner/pi-ai";
import type { Agent, RunResult } from "@harness/core";
import { DaemonRuntime } from "../../src/daemon/runtime.js";
import type { IpcRequest, IpcResponse } from "../../src/daemon/types.js";

const TEST_DIR = join(
  tmpdir(),
  `harness-tq-concurrency-${process.pid}-${Date.now()}`,
);

let savedHome: string | undefined;
let savedState: string | undefined;

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(join(TEST_DIR, "state", "logs"), { recursive: true });
  savedHome = process.env.HARNESS_HOME;
  savedState = process.env.HARNESS_STATE;
  process.env.HARNESS_HOME = join(TEST_DIR, "home");
  process.env.HARNESS_STATE = join(TEST_DIR, "state");
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHome;
  if (savedState === undefined) delete process.env.HARNESS_STATE;
  else process.env.HARNESS_STATE = savedState;
  await rm(TEST_DIR, { recursive: true, force: true });
});

/* ─── Fake agent ───
 *
 * Records start/end events and a snapshot of the messages array at run
 * start, waits `delayMs` (the window where a second submit-turn could
 * race in), optionally throws on a trigger text, then appends an
 * assistant message in place — exactly like the real agent loop mutates
 * the caller's array.
 */

interface RunEvent {
  kind: "start" | "end";
  text: string;
}

interface RunCall {
  snapshot: string[];
}

function textOf(msg: Message): string {
  return typeof msg.content === "string" ? msg.content : "";
}

function createFakeAgent(
  events: RunEvent[],
  opts: { delayMs?: number; failOn?: string } = {},
): { agent: Agent; calls: RunCall[] } {
  const delayMs = opts.delayMs ?? 40;
  const calls: RunCall[] = [];

  const agent: Agent = {
    setModel() {},
    setSystemPrompt() {},
    async run(messages: Message[]): Promise<RunResult> {
      const lastUser = messages.filter((m) => m.role === "user").at(-1);
      const userText = lastUser ? textOf(lastUser) : "";
      events.push({ kind: "start", text: userText });
      calls.push({
        snapshot: messages.map((m) => `${m.role}:${textOf(m)}`),
      });

      await new Promise((r) => setTimeout(r, delayMs));

      if (opts.failOn && userText.includes(opts.failOn)) {
        throw new Error(`simulated provider failure on: ${userText}`);
      }

      const reply = `reply:${userText}`;
      messages.push({
        role: "assistant",
        content: reply,
        timestamp: Date.now(),
      } as Message);
      events.push({ kind: "end", text: userText });

      return {
        aborted: false,
        turns: 1,
        finalMessage: reply,
        toolCallCount: 0,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cacheRead: 0,
          cacheWrite: 0,
        },
      };
    },
  };

  return { agent, calls };
}

/* ─── Runtime harness ───
 *
 * Drives the real DaemonRuntime.handleIpcRequest without start(): env
 * vars point paths at a temp dir, the agent is injected, and the
 * private handler is invoked directly (no socket needed).
 */

type RuntimeInternals = {
  agent: Agent;
  handleIpcRequest(
    req: IpcRequest,
    send?: (resp: IpcResponse) => void,
  ): Promise<IpcResponse>;
};

function createRuntime(agent: Agent): {
  submit: (req: IpcRequest) => Promise<IpcResponse>;
} {
  const runtime = new DaemonRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  internals.agent = agent;
  return {
    submit: (req) => internals.handleIpcRequest(req),
  };
}

async function createSession(
  submit: (req: IpcRequest) => Promise<IpcResponse>,
): Promise<string> {
  const resp = await submit({ type: "create-session" });
  if (resp.type !== "session-created") {
    throw new Error(`create-session failed: ${JSON.stringify(resp)}`);
  }
  return resp.sessionId;
}

describe("Turn-queue serialization in DaemonRuntime (race condition regression)", () => {
  it("runs two parallel submit-turns on the SAME session strictly serial — no interleaves on entry.messages", async () => {
    const events: RunEvent[] = [];
    const { agent, calls } = createFakeAgent(events);
    const { submit } = createRuntime(agent);
    const sid = await createSession(submit);

    const [r1, r2] = await Promise.all([
      submit({ type: "submit-turn", text: "first", sessionId: sid }),
      submit({ type: "submit-turn", text: "second", sessionId: sid }),
    ]);

    expect(r1.type).toBe("turn-complete");
    expect(r2.type).toBe("turn-complete");
    if (r1.type !== "turn-complete" || r2.type !== "turn-complete") return;
    expect(r1.finalResponse).toBe("reply:first");
    expect(r2.finalResponse).toBe("reply:second");
    expect(r2.turnsCompleted).toBe(2);

    // Strictly serial, in submission order: turn "first" fully completes
    // before turn "second" starts. With the IIFE race both turns started
    // immediately (start, start, end, end).
    expect(events).toEqual([
      { kind: "start", text: "first" },
      { kind: "end", text: "first" },
      { kind: "start", text: "second" },
      { kind: "end", text: "second" },
    ]);

    // No interleaves on entry.messages: turn 1 saw only its own user
    // message; turn 2 saw the completed turn 1 plus its own message.
    expect(calls[0]!.snapshot).toEqual(["user:first"]);
    expect(calls[1]!.snapshot).toEqual([
      "user:first",
      "assistant:reply:first",
      "user:second",
    ]);
  });

  it("does NOT block a parallel submit-turn on a DIFFERENT session", async () => {
    const events: RunEvent[] = [];
    const { agent } = createFakeAgent(events, { delayMs: 80 });
    const { submit } = createRuntime(agent);
    const sid1 = await createSession(submit);
    const sid2 = await createSession(submit);

    const [r1, r2] = await Promise.all([
      submit({ type: "submit-turn", text: "turn-a", sessionId: sid1 }),
      submit({ type: "submit-turn", text: "turn-b", sessionId: sid2 }),
    ]);

    expect(r1.type).toBe("turn-complete");
    expect(r2.type).toBe("turn-complete");

    // Session B's turn started while session A's turn was still running —
    // separate queues, no cross-session blocking.
    const idxStartA = events.findIndex(
      (e) => e.kind === "start" && e.text === "turn-a",
    );
    const idxEndA = events.findIndex(
      (e) => e.kind === "end" && e.text === "turn-a",
    );
    const idxStartB = events.findIndex(
      (e) => e.kind === "start" && e.text === "turn-b",
    );
    expect(idxStartA).toBeGreaterThanOrEqual(0);
    expect(idxEndA).toBeGreaterThan(idxStartA);
    expect(idxStartB).toBeGreaterThan(idxStartA);
    expect(idxStartB).toBeLessThan(idxEndA);
  });

  it("keeps the queue alive after a failed turn — the next turn still runs", async () => {
    const events: RunEvent[] = [];
    const { agent } = createFakeAgent(events, {
      delayMs: 10,
      failOn: "boom",
    });
    const { submit } = createRuntime(agent);
    const sid = await createSession(submit);

    const [r1, r2] = await Promise.all([
      submit({ type: "submit-turn", text: "boom", sessionId: sid }),
      submit({ type: "submit-turn", text: "aftermath", sessionId: sid }),
    ]);

    // The failing turn surfaces an error response…
    expect(r1.type).toBe("error");
    // …but the queued second turn still ran to completion.
    expect(r2.type).toBe("turn-complete");
    if (r2.type !== "turn-complete") return;
    expect(r2.finalResponse).toBe("reply:aftermath");

    expect(events).toEqual([
      { kind: "start", text: "boom" },
      { kind: "start", text: "aftermath" },
      { kind: "end", text: "aftermath" },
    ]);
  });
});
