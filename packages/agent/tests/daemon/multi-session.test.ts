import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startIpcServer, stopIpcServer, sendIpcStreaming } from "../../src/daemon/ipc.js";
import type { IpcRequest, IpcResponse, IpcHandler } from "../../src/daemon/types.js";
import type { IpcResponse as Resp } from "../../src/daemon/types.js";

const TEST_DIR = join(tmpdir(), `harness-multi-session-${process.pid}-${Date.now()}`);
const SOCKET_FILE = join(TEST_DIR, "daemon.sock");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

/**
 * Mock daemon handler that simulates the session registry behavior:
 * - create-session → returns a new sessionId
 * - submit-turn with text → streams "token" events + turn-complete
 * - submit-turn without sessionId → creates a session implicitly
 *
 * Sessions are tracked in a Map, turns interleaved to verify isolation.
 */
function createMockHandler(): {
  handler: IpcHandler;
  sessions: Map<string, { messages: string[]; turns: number }>;
} {
  const sessions = new Map<string, { messages: string[]; turns: number }>();
  let counter = 0;

  const handler: IpcHandler = async (
    req: IpcRequest,
    send?: (resp: IpcResponse) => void,
  ): Promise<IpcResponse> => {
    switch (req.type) {
      case "create-session": {
        const id = `sess-${++counter}`;
        sessions.set(id, { messages: [], turns: 0 });
        return {
          type: "session-created",
          sessionId: id,
          origin: req.origin ?? "api",
          createdAt: new Date().toISOString(),
        };
      }

      case "submit-turn": {
        let sessionId = req.sessionId ?? "";
        if (!sessionId) {
          sessionId = `sess-${++counter}`;
          sessions.set(sessionId, { messages: [], turns: 0 });
        }
        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, { messages: [], turns: 0 });
        }

        const entry = sessions.get(sessionId)!;
        const userText = req.text ?? "";
        entry.messages.push(userText);

        // Simulate streaming token events
        if (send) {
          const responseText = `Response to "${userText}" in session ${sessionId}`;
          const tokens = responseText.split(" ");
          for (const token of tokens) {
            send({
              type: "turn-event",
              sessionId,
              event: { type: "token", text: token + " " },
            });
          }
        }

        // Simulate tool call events
        if (send) {
          send({
            type: "turn-event",
            sessionId,
            event: {
              type: "tool_call_start",
              name: "echo",
              args: { text: userText },
            },
          });
          send({
            type: "turn-event",
            sessionId,
            event: {
              type: "tool_call_done",
              name: "echo",
              result: `echoed: ${userText}`,
            },
          });
        }

        entry.turns++;

        return {
          type: "turn-complete",
          sessionId,
          finalResponse: `Response to "${userText}" in session ${sessionId}`,
          info: `Turn ${entry.turns}`,
          turnsCompleted: entry.turns,
        };
      }

      case "list-sessions": {
        const summaries = [...sessions.entries()].map(([id, entry]) => ({
          sessionId: id,
          title: `Session ${id}`,
          origin: "api" as const,
          status: "active" as const,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          model: "test",
          turnsCompleted: entry.turns,
          inMemory: true,
        }));
        return { type: "sessions-listed", sessions: summaries };
      }

      case "resume-session": {
        const id = req.sessionId;
        if (sessions.has(id)) {
          return {
            type: "session-resumed",
            sessionId: id,
            messageCount: sessions.get(id)!.messages.length,
          };
        }
        return { type: "error", message: `Session not found: ${id}` };
      }

      case "ping":
        return { type: "pong", uptime: 0, pid: process.pid };

      default:
        return { type: "error", message: "not implemented" };
    }
  };

  return { handler, sessions };
}

describe("Multi-Session IPC: parallel sessions with interleaved turns", () => {
  it("creates two sessions, interleaves turns, verifies separate histories", async () => {
    const { handler, sessions } = createMockHandler();
    const server = await startIpcServer(SOCKET_FILE, handler);

    try {
      // ── Phase 1: Create two sessions ──
      const createResp1 = await sendIpcStreaming(
        SOCKET_FILE,
        { type: "create-session", origin: "api" },
      );
      expect(createResp1.type).toBe("session-created");
      if (createResp1.type !== "session-created") return;
      const sid1 = createResp1.sessionId;

      const createResp2 = await sendIpcStreaming(
        SOCKET_FILE,
        { type: "create-session", origin: "tui" },
      );
      expect(createResp2.type).toBe("session-created");
      if (createResp2.type !== "session-created") return;
      const sid2 = createResp2.sessionId;

      expect(sid1).not.toBe(sid2);

      // ── Phase 2: Interleaved turns with streaming ──

      // Turn 1 in session 1
      const events1a: Resp[] = [];
      const resp1a = await sendIpcStreaming(
        SOCKET_FILE,
        { type: "submit-turn", text: "Hello from session 1", sessionId: sid1 },
        (e) => events1a.push(e),
      );
      expect(resp1a.type).toBe("turn-complete");
      if (resp1a.type !== "turn-complete") return;
      expect(resp1a.sessionId).toBe(sid1);
      expect(resp1a.finalResponse).toContain("Hello from session 1");
      // Should have received token + tool_call events
      const tokenEvents1a = events1a.filter(
        (e) => e.type === "turn-event" && e.event.type === "token",
      );
      expect(tokenEvents1a.length).toBeGreaterThan(0);

      // Turn 1 in session 2
      const events2a: Resp[] = [];
      const resp2a = await sendIpcStreaming(
        SOCKET_FILE,
        { type: "submit-turn", text: "Hello from session 2", sessionId: sid2 },
        (e) => events2a.push(e),
      );
      expect(resp2a.type).toBe("turn-complete");
      if (resp2a.type !== "turn-complete") return;
      expect(resp2a.sessionId).toBe(sid2);
      expect(resp2a.finalResponse).toContain("Hello from session 2");

      // Turn 2 in session 1 (interleaved)
      const resp1b = await sendIpcStreaming(
        SOCKET_FILE,
        { type: "submit-turn", text: "Second message in session 1", sessionId: sid1 },
      );
      expect(resp1b.type).toBe("turn-complete");
      if (resp1b.type !== "turn-complete") return;
      expect(resp1b.sessionId).toBe(sid1);

      // Turn 2 in session 2 (interleaved)
      const resp2b = await sendIpcStreaming(
        SOCKET_FILE,
        { type: "submit-turn", text: "Second message in session 2", sessionId: sid2 },
      );
      expect(resp2b.type).toBe("turn-complete");
      if (resp2b.type !== "turn-complete") return;
      expect(resp2b.sessionId).toBe(sid2);

      // ── Phase 3: Verify separate histories ──
      const entry1 = sessions.get(sid1)!;
      const entry2 = sessions.get(sid2)!;

      expect(entry1.turns).toBe(2);
      expect(entry2.turns).toBe(2);
      expect(entry1.messages).toEqual([
        "Hello from session 1",
        "Second message in session 1",
      ]);
      expect(entry2.messages).toEqual([
        "Hello from session 2",
        "Second message in session 2",
      ]);

      // Sessions must not cross-contaminate
      expect(entry1.messages).not.toContain("Hello from session 2");
      expect(entry2.messages).not.toContain("Hello from session 1");
    } finally {
      await stopIpcServer(server, SOCKET_FILE);
    }
  });

  it("lists sessions including both in-memory entries", async () => {
    const { handler } = createMockHandler();
    const server = await startIpcServer(SOCKET_FILE, handler);

    try {
      // Create two sessions
      await sendIpcStreaming(SOCKET_FILE, { type: "create-session" });
      await sendIpcStreaming(SOCKET_FILE, { type: "create-session" });

      // List
      const resp = await sendIpcStreaming(SOCKET_FILE, { type: "list-sessions" });
      expect(resp.type).toBe("sessions-listed");
      if (resp.type !== "sessions-listed") return;
      expect(resp.sessions.length).toBe(2);
      expect(resp.sessions.every((s) => s.inMemory)).toBe(true);
    } finally {
      await stopIpcServer(server, SOCKET_FILE);
    }
  });

  it("resumes a session by id", async () => {
    const { handler } = createMockHandler();
    const server = await startIpcServer(SOCKET_FILE, handler);

    try {
      const createResp = await sendIpcStreaming(SOCKET_FILE, { type: "create-session" });
      expect(createResp.type).toBe("session-created");
      if (createResp.type !== "session-created") return;

      // Submit a turn (adds messages)
      await sendIpcStreaming(
        SOCKET_FILE,
        { type: "submit-turn", text: "test message", sessionId: createResp.sessionId },
      );

      // Resume
      const resumeResp = await sendIpcStreaming(
        SOCKET_FILE,
        { type: "resume-session", sessionId: createResp.sessionId },
      );
      expect(resumeResp.type).toBe("session-resumed");
      if (resumeResp.type !== "session-resumed") return;
      expect(resumeResp.sessionId).toBe(createResp.sessionId);
      expect(resumeResp.messageCount).toBe(1);
    } finally {
      await stopIpcServer(server, SOCKET_FILE);
    }
  });

  it("submit-turn without sessionId creates a new session", async () => {
    const { handler, sessions } = createMockHandler();
    const server = await startIpcServer(SOCKET_FILE, handler);

    try {
      const resp = await sendIpcStreaming(
        SOCKET_FILE,
        { type: "submit-turn", text: "no session specified" },
      );
      expect(resp.type).toBe("turn-complete");
      if (resp.type !== "turn-complete") return;
      expect(resp.sessionId).toBeTruthy();
      expect(sessions.has(resp.sessionId)).toBe(true);
      expect(sessions.get(resp.sessionId)!.messages).toEqual(["no session specified"]);
    } finally {
      await stopIpcServer(server, SOCKET_FILE);
    }
  });

  it("streaming events are received before turn-complete", async () => {
    const { handler } = createMockHandler();
    const server = await startIpcServer(SOCKET_FILE, handler);

    try {
      const createResp = await sendIpcStreaming(SOCKET_FILE, { type: "create-session" });
      if (createResp.type !== "session-created") return;

      const events: Resp[] = [];
      const finalResp = await sendIpcStreaming(
        SOCKET_FILE,
        { type: "submit-turn", text: "streaming test", sessionId: createResp.sessionId },
        (e) => events.push(e),
      );

      // All events should be turn-event type (intermediate)
      expect(events.every((e) => e.type === "turn-event")).toBe(true);

      // Final response should be terminal
      expect(finalResp.type).toBe("turn-complete");

      // Events must arrive BEFORE the terminal response
      // (already verified by sendIpcStreaming's protocol)
      expect(events.length).toBeGreaterThan(0);

      // Verify event types
      const eventTypes = events.map((e) => {
        if (e.type === "turn-event") return e.event.type;
        return "unknown";
      });
      expect(eventTypes).toContain("token");
      expect(eventTypes).toContain("tool_call_start");
      expect(eventTypes).toContain("tool_call_done");
    } finally {
      await stopIpcServer(server, SOCKET_FILE);
    }
  });

  it("two sessions run truly parallel via concurrent submit-turn", async () => {
    const { handler, sessions } = createMockHandler();
    const server = await startIpcServer(SOCKET_FILE, handler);

    try {
      // Create sessions
      const c1 = await sendIpcStreaming(SOCKET_FILE, { type: "create-session" });
      const c2 = await sendIpcStreaming(SOCKET_FILE, { type: "create-session" });
      if (c1.type !== "session-created" || c2.type !== "session-created") return;

      // Fire both turns concurrently
      const [r1, r2] = await Promise.all([
        sendIpcStreaming(
          SOCKET_FILE,
          { type: "submit-turn", text: "parallel turn 1", sessionId: c1.sessionId },
        ),
        sendIpcStreaming(
          SOCKET_FILE,
          { type: "submit-turn", text: "parallel turn 2", sessionId: c2.sessionId },
        ),
      ]);

      expect(r1.type).toBe("turn-complete");
      expect(r2.type).toBe("turn-complete");
      if (r1.type !== "turn-complete" || r2.type !== "turn-complete") return;

      expect(r1.sessionId).toBe(c1.sessionId);
      expect(r2.sessionId).toBe(c2.sessionId);

      // Histories must be isolated
      expect(sessions.get(c1.sessionId)!.messages).toEqual(["parallel turn 1"]);
      expect(sessions.get(c2.sessionId)!.messages).toEqual(["parallel turn 2"]);
    } finally {
      await stopIpcServer(server, SOCKET_FILE);
    }
  });
});
