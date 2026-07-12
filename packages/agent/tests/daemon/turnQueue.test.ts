import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startIpcServer, stopIpcServer, sendIpcStreaming } from "../../src/daemon/ipc.js";
import type { IpcRequest, IpcResponse, IpcHandler } from "../../src/daemon/types.js";
import { createMailbox, type Mailbox } from "@harness/core";

const TEST_DIR = join(tmpdir(), `harness-turn-queue-${process.pid}-${Date.now()}`);
const SOCKET_FILE = join(TEST_DIR, "daemon.sock");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true, true: true } as never).catch(() => mkdir(TEST_DIR, { recursive: true }));
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

/**
 * Mock agent handler that replicates DaemonRuntime's turn-queue + mailbox
 * pattern for the submit-turn IPC request.
 *
 * Key behaviors under test:
 * - Each session has a turnQueue (Promise chain) + mailbox
 * - A submit-turn arriving while a turn is running on the same session
 *   goes to the mailbox (steering), not as a new turn
 * - Different sessions run turns in parallel
 */
function createTurnQueueHandler(): {
  handler: IpcHandler;
  state: {
    turnStartedCount: Map<string, number>;
    maxConcurrentTurns: number;
  };
} {
  interface TestSessionEntry {
    messages: string[];
    turns: number;
    mailbox: Mailbox;
    turnQueue: Promise<unknown>;
    turnRunning: boolean;
  }

  const sessions = new Map<string, TestSessionEntry>();
  const turnStartedCount = new Map<string, number>();
  const state = {
    turnStartedCount,
    maxConcurrentTurns: 0,
  };
  let concurrentTurns = 0;

  function createEntry(id: string): TestSessionEntry {
    const entry: TestSessionEntry = {
      messages: [],
      turns: 0,
      mailbox: createMailbox(),
      turnQueue: Promise.resolve(),
      turnRunning: false,
    };
    sessions.set(id, entry);
    turnStartedCount.set(id, 0);
    return entry;
  }

  /** Simulate an agent turn — takes 100ms, during which a second message may arrive */
  async function runTurn(
    sessionId: string,
    entry: TestSessionEntry,
    userText: string,
    send?: (resp: IpcResponse) => void,
  ): Promise<IpcResponse> {
    entry.turnRunning = true;
    concurrentTurns++;
    state.maxConcurrentTurns = Math.max(state.maxConcurrentTurns, concurrentTurns);
    turnStartedCount.set(sessionId, (turnStartedCount.get(sessionId) ?? 0) + 1);

    // Simulate streaming tokens
    if (send) {
      const tokens = `Response to ${userText}`.split(" ");
      for (const token of tokens) {
        send({ type: "turn-event", sessionId, event: { type: "token", text: token + " " } });
      }
    }

    // Simulate turn duration — this is the window where a second
    // submit-turn might arrive
    await new Promise((r) => setTimeout(r, 100));

    // Drain mailbox (the agent loop does this at iteration boundaries)
    const steered = entry.mailbox.drainAll();
    if (steered.length > 0 && send) {
      send({
        type: "turn-event",
        sessionId,
        event: { type: "token", text: `[steered: ${steered.join(", ")}] ` },
      });
    }

    entry.turns++;
    entry.turnRunning = false;
    concurrentTurns--;

    return {
      type: "turn-complete",
      sessionId,
      finalResponse: `Response to ${userText}`,
      info: `Turn ${entry.turns}`,
      turnsCompleted: entry.turns,
    };
  }

  const handler: IpcHandler = async (req: IpcRequest, send?: (resp: IpcResponse) => void): Promise<IpcResponse> => {
    switch (req.type) {
      case "create-session": {
        const id = `sess-${sessions.size + 1}`;
        createEntry(id);
        return {
          type: "session-created",
          sessionId: id,
          origin: "api",
          createdAt: new Date().toISOString(),
        };
      }

      case "submit-turn": {
        let sessionId = req.sessionId ?? "";
        if (!sessionId) {
          sessionId = `sess-${sessions.size + 1}`;
          createEntry(sessionId);
        }
        if (!sessions.has(sessionId)) {
          createEntry(sessionId);
        }

        const entry = sessions.get(sessionId)!;
        const userText = req.text ?? "";

        // If a turn is already running on this session, push to mailbox
        // instead of starting a second concurrent turn
        if (entry.turnRunning) {
          entry.mailbox.push(userText);
          // Return immediately — the running turn will drain the mailbox
          return {
            type: "turn-complete",
            sessionId,
            finalResponse: `Queued (steering): ${userText}`,
            info: "queued",
            turnsCompleted: entry.turns,
          };
        }

        // No turn running — start one, chained on the turnQueue
        entry.messages.push(userText);

        // Chain on turnQueue (same pattern as DaemonRuntime)
        const turnPromise = (async () => {
          return await runTurn(sessionId, entry, userText, send);
        })();

        entry.turnQueue = entry.turnQueue.then(() => turnPromise, () => turnPromise);

        return await turnPromise;
      }

      case "ping":
        return { type: "pong", uptime: 0, pid: process.pid };

      default:
        return { type: "error", message: "not implemented" };
    }
  };

  return { handler, state };
}

describe("F2: Turn serialization per session (race condition regression)", () => {
  it("serializes concurrent submit-turns on the SAME session — never runs two turns in parallel", async () => {
    const { handler, state } = createTurnQueueHandler();
    const server = await startIpcServer(SOCKET_FILE, handler);

    try {
      // Create a session
      const createResp = await sendIpcStreaming(SOCKET_FILE, { type: "create-session" });
      expect(createResp.type).toBe("session-created");
      if (createResp.type !== "session-created") return;
      const sid = createResp.sessionId;

      // Fire two submit-turns concurrently on the SAME session
      const [r1, r2] = await Promise.all([
        sendIpcStreaming(SOCKET_FILE, { type: "submit-turn", text: "first message", sessionId: sid }),
        sendIpcStreaming(SOCKET_FILE, { type: "submit-turn", text: "second message", sessionId: sid }),
      ]);

      // Both should complete successfully
      expect(r1.type).toBe("turn-complete");
      expect(r2.type).toBe("turn-complete");
      if (r1.type !== "turn-complete" || r2.type !== "turn-complete") return;

      // The first turn runs normally; the second arrives while the first
      // is running and is queued to the mailbox (steering), not started
      // as a separate turn.
      const starts = state.turnStartedCount.get(sid) ?? 0;
      expect(starts).toBe(1); // Only one actual turn was started

      // maxConcurrentTurns should be 1 — never two parallel turns
      // on the same session
      expect(state.maxConcurrentTurns).toBe(1);

      // One response is the actual turn, the other is the queued steering
      const responses = [r1.finalResponse, r2.finalResponse].sort();
      expect(responses[0]).toContain("Queued");
      expect(responses[1]).toContain("Response to");
    } finally {
      await stopIpcServer(server, SOCKET_FILE);
    }
  });

  it("allows concurrent turns on DIFFERENT sessions in parallel", async () => {
    const { handler, state } = createTurnQueueHandler();
    const server = await startIpcServer(SOCKET_FILE, handler);

    try {
      // Create two sessions
      const c1 = await sendIpcStreaming(SOCKET_FILE, { type: "create-session" });
      const c2 = await sendIpcStreaming(SOCKET_FILE, { type: "create-session" });
      if (c1.type !== "session-created" || c2.type !== "session-created") return;

      // Fire turns concurrently on DIFFERENT sessions
      const [r1, r2] = await Promise.all([
        sendIpcStreaming(SOCKET_FILE, { type: "submit-turn", text: "turn A", sessionId: c1.sessionId }),
        sendIpcStreaming(SOCKET_FILE, { type: "submit-turn", text: "turn B", sessionId: c2.sessionId }),
      ]);

      expect(r1.type).toBe("turn-complete");
      expect(r2.type).toBe("turn-complete");

      // Both turns ran truly in parallel (different sessions)
      expect(state.maxConcurrentTurns).toBe(2);
    } finally {
      await stopIpcServer(server, SOCKET_FILE);
    }
  });

  it("mailbox message arrives as steering in the running turn, not as a separate turn", async () => {
    const { handler, state } = createTurnQueueHandler();
    const server = await startIpcServer(SOCKET_FILE, handler);

    try {
      const createResp = await sendIpcStreaming(SOCKET_FILE, { type: "create-session" });
      if (createResp.type !== "session-created") return;
      const sid = createResp.sessionId;

      // Start a turn (100ms duration), then after a short delay send a
      // second message that should go to the mailbox
      const events1: IpcResponse[] = [];
      const turn1Promise = sendIpcStreaming(
        SOCKET_FILE,
        { type: "submit-turn", text: "long turn", sessionId: sid },
        (e) => events1.push(e),
      );

      // Small delay to ensure turn1 has started
      await new Promise((r) => setTimeout(r, 20));

      // Send a second message while turn1 is running
      const turn2Resp = await sendIpcStreaming(
        SOCKET_FILE,
        { type: "submit-turn", text: "steering message", sessionId: sid },
      );

      // Wait for turn1 to complete
      const turn1Resp = await turn1Promise;

      // turn2 should return immediately as queued
      expect(turn2Resp.type).toBe("turn-complete");
      if (turn2Resp.type !== "turn-complete") return;
      expect(turn2Resp.info).toBe("queued");
      expect(turn2Resp.finalResponse).toContain("Queued");

      // turn1 should have received the steering message as a token event
      expect(turn1Resp.type).toBe("turn-complete");
      const steerTokens = events1.filter(
        (e) => e.type === "turn-event" && e.event.type === "token" && e.event.text.includes("steered"),
      );
      expect(steerTokens.length).toBe(1);
      expect(steerTokens[0]!.event.text).toContain("steering message");

      // Only one turn was started — the second was steering, not a new turn
      expect(state.turnStartedCount.get(sid)).toBe(1);
    } finally {
      await stopIpcServer(server, SOCKET_FILE);
    }
  });
});
