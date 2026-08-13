import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessPaths } from "@harness/core";
import {
  createSession,
  recordTurn,
  loadSession,
  turnsToMessages,
  countTurnsInTranscript,
  markActiveSessionsIdle,
  listSessions,
  endSession,
  type SessionTurn,
} from "../../src/core/session.js";

function makePaths(base: string): HarnessPaths {
  return {
    home: join(base, "home"),
    state: join(base, "state"),
    core: join(base, "home", "core.md"),
    agents: join(base, "home", "AGENTS.md"),
    config: join(base, "home", "config.json"),
    memory: join(base, "home", "memory"),
    inbox: join(base, "home", "memory", "_inbox.md"),
    sources: join(base, "home", "sources"),
    skills: join(base, "home", "skills"),
    sessions: join(base, "state", "sessions"),
    metrics: join(base, "state", "metrics"),
    index: join(base, "state", "index"),
  };
}

function baseTurn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: "turn-1",
    role: "assistant",
    content: "Hello from turn 1",
    userContent: "Tell me about the secret keyword BANANA",
    tokens: {
      input: 10,
      output: 5,
      total: 15,
      cacheRead: 0,
      cacheWrite: 0,
    },
    timing: {
      startedAt: "2026-07-11T10:00:00.000Z",
      latencyMs: 500,
    },
    model: "test-model",
    timestamp: "2026-07-11T10:00:01.000Z",
    ...overrides,
  };
}

describe("Session resume after daemon restart", () => {
  let baseDir: string;
  let paths: HarnessPaths;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "harness-resume-test-"));
    paths = makePaths(baseDir);
  });

  afterEach(() => {
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("1. Root cause: turnsToMessages normalizes string content", () => {
    it("assistant message from fallback path has array content (not string)", () => {
      // Simulate a turn persisted WITHOUT turn.messages (the --session path).
      // turn.content is a plain string, which used to crash pi-ai's flatMap.
      const turn = baseTurn({ id: "t1", content: "The secret is BANANA" });
      // No turn.messages — forces the fallback synthesis path.
      const messages = turnsToMessages([turn]);

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");

      // The critical assertion: content must be an array, not a string.
      const assistantContent = (messages[1] as unknown as { content: unknown }).content;
      expect(Array.isArray(assistantContent)).toBe(true);

      // And the text must be preserved.
      const firstBlock = (assistantContent as Array<{ type: string; text: string }>)[0];
      expect(firstBlock.type).toBe("text");
      expect(firstBlock.text).toBe("The secret is BANANA");
    });

    it("assistant messages in turn.messages with string content are also normalized", () => {
      // Simulate old persisted data where turn.messages contains
      // assistant messages with string content.
      const turn = baseTurn({
        id: "t1",
        messages: [
          { role: "user", content: "What is the secret?", timestamp: 1 },
          // Assistant with string content — this is what used to crash.
          { role: "assistant", content: "The secret is BANANA", timestamp: 2 },
        ] as unknown as SessionTurn["messages"],
      });
      const messages = turnsToMessages([turn]);

      expect(messages).toHaveLength(2);
      const assistantContent = (messages[1] as unknown as { content: unknown }).content;
      expect(Array.isArray(assistantContent)).toBe(true);
      expect(
        (assistantContent as Array<{ type: string; text: string }>)[0].text,
      ).toBe("The secret is BANANA");
    });

    it("full round-trip: create → record → load → turnsToMessages → content is array", async () => {
      // This simulates the exact bug scenario:
      // 1. Session created, turn recorded (no turn.messages — --session path)
      // 2. Daemon "restarts" — loadSession reads from disk
      // 3. turnsToMessages reconstructs the message history
      // 4. The assistant message content must be an array for pi-ai to process it.
      const session = await createSession(paths, { model: "test-model" });
      const turn = baseTurn({
        id: "t1",
        content: "I remember the secret keyword BANANA",
        userContent: "Remember the secret keyword BANANA",
        // No turn.messages — simulates the `send --session` path.
      });
      await recordTurn(session, turn, paths);

      // Simulated restart: load from disk.
      const loaded = await loadSession(session.id, paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.turns).toHaveLength(1);

      // Reconstruct messages — this used to throw.
      const messages = turnsToMessages(loaded!.turns);
      expect(messages).toHaveLength(2);

      // Assistant content must be an array — not a string that would crash flatMap.
      const assistantMsg = messages[1];
      expect(assistantMsg.role).toBe("assistant");
      expect(
        Array.isArray((assistantMsg as unknown as { content: unknown }).content),
      ).toBe(true);

      // Content references the original turn 1 content.
      const blocks = (assistantMsg as unknown as { content: Array<{ type: string; text: string }> }).content;
      expect(blocks[0].text).toContain("BANANA");

      // User message also references turn 1 content.
      const userMsg = messages[0];
      expect(userMsg.role).toBe("user");
      expect((userMsg as unknown as { content: string }).content).toContain("BANANA");
    });
  });

  describe("2. turnsCompleted: derived from persisted history", () => {
    it("countTurnsInTranscript returns correct count after recording turns", async () => {
      const session = await createSession(paths, { model: "test-model" });
      await recordTurn(session, baseTurn({ id: "t1" }), paths);
      await recordTurn(
        { ...session, tokenTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0 } },
        baseTurn({ id: "t2" }),
        paths,
      );
      await recordTurn(
        { ...session, tokenTotals: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheRead: 0, cacheWrite: 0 } },
        baseTurn({ id: "t3" }),
        paths,
      );

      const count = await countTurnsInTranscript(session.id, paths);
      expect(count).toBe(3);
    });

    it("countTurnsInTranscript returns 0 for session with no turns", async () => {
      const session = await createSession(paths, { model: "test-model" });
      const count = await countTurnsInTranscript(session.id, paths);
      expect(count).toBe(0);
    });

    it("countTurnsInTranscript returns 0 for unknown session", async () => {
      const count = await countTurnsInTranscript("nonexistent", paths);
      expect(count).toBe(0);
    });
  });

  describe("3. Status semantics: orphaned active markers cleaned on start", () => {
    it("markActiveSessionsIdle sets all active sessions to idle", async () => {
      const session1 = await createSession(paths, { model: "test-model" });
      const session2 = await createSession(paths, { model: "test-model" });
      // Both start as "active".

      const count = await markActiveSessionsIdle(paths);
      expect(count).toBe(2);

      const sessions = await listSessions(paths);
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.status === "idle")).toBe(true);
    });

    it("markActiveSessionsIdle does not touch already-ended sessions", async () => {
      const session = await createSession(paths, { model: "test-model" });
      await endSession(session, paths);

      const count = await markActiveSessionsIdle(paths);
      expect(count).toBe(0);

      const sessions = await listSessions(paths);
      expect(sessions[0].status).toBe("ended");
    });

    it("markActiveSessionsIdle is idempotent", async () => {
      await createSession(paths, { model: "test-model" });
      await createSession(paths, { model: "test-model" });

      await markActiveSessionsIdle(paths);
      const secondCount = await markActiveSessionsIdle(paths);
      expect(secondCount).toBe(0);
    });

    it("simulated restart: active → idle cleanup, then resume works", async () => {
      // Phase 1: Create session + record turn (daemon running)
      const session = await createSession(paths, { model: "test-model" });
      const turn = baseTurn({
        id: "t1",
        content: "Remember the keyword BANANA",
        userContent: "Remember the keyword BANANA",
      });
      await recordTurn(session, turn, paths);
      // Session is "active" in the index (daemon is running it).

      // Phase 2: Simulate daemon crash (kill -9).
      // No endSession() called — status stays "active" in the index.

      // Phase 3: New daemon starts — marks orphaned active sessions as idle.
      const cleaned = await markActiveSessionsIdle(paths);
      expect(cleaned).toBe(1);

      // Verify status is now "idle".
      const sessions = await listSessions(paths);
      expect(sessions[0].status).toBe("idle");

      // Phase 4: Resume session — loadSession + turnsToMessages.
      const loaded = await loadSession(session.id, paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.turns).toHaveLength(1);

      const messages = turnsToMessages(loaded!.turns);
      expect(messages).toHaveLength(2);
      // Content references turn 1.
      const assistantContent = (messages[1] as unknown as { content: Array<{ type: string; text: string }> }).content;
      expect(assistantContent[0].text).toContain("BANANA");

      // Turn count derived from history, not in-memory counter.
      const turnCount = await countTurnsInTranscript(session.id, paths);
      expect(turnCount).toBe(1);
    });
  });
});

describe("lastTurnUsage from persisted transcript", () => {
  let baseDir: string;
  let paths: HarnessPaths;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "harness-usage-test-"));
    paths = makePaths(baseDir);
  });

  afterEach(() => {
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns the last turn's measured usage on resume", async () => {
    const session = await createSession(paths, { model: "test-model" });
    await recordTurn(
      session,
      baseTurn({
        id: "t1",
        tokens: { input: 1_000, output: 200, total: 1_200, cacheRead: 400, cacheWrite: 100 },
      }),
      paths,
    );
    await recordTurn(
      session,
      baseTurn({
        id: "t2",
        tokens: { input: 2_000, output: 500, total: 2_500, cacheRead: 800, cacheWrite: 200 },
      }),
      paths,
    );

    const loaded = await loadSession(session.id, paths);
    expect(loaded).not.toBeNull();
    expect(loaded!.lastTurnUsage).toEqual({
      inputTokens: 2_000,
      outputTokens: 500,
      totalTokens: 2_500,
      cacheRead: 800,
      cacheWrite: 200,
    });
  });

  it("skips trailing zero-usage turns (provider without usage reporting)", async () => {
    const session = await createSession(paths, { model: "test-model" });
    await recordTurn(
      session,
      baseTurn({
        id: "t1",
        tokens: { input: 1_000, output: 200, total: 1_200, cacheRead: 400, cacheWrite: 100 },
      }),
      paths,
    );
    // A later turn where the provider reported no usage at all (all zero).
    await recordTurn(
      session,
      baseTurn({
        id: "t2",
        tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      paths,
    );

    const loaded = await loadSession(session.id, paths);
    expect(loaded).not.toBeNull();
    expect(loaded!.lastTurnUsage).toEqual({
      inputTokens: 1_000,
      outputTokens: 200,
      totalTokens: 1_200,
      cacheRead: 400,
      cacheWrite: 100,
    });
  });

  it("is undefined when no turn has measured usage", async () => {
    const session = await createSession(paths, { model: "test-model" });
    await recordTurn(
      session,
      baseTurn({
        id: "t1",
        tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      paths,
    );

    const loaded = await loadSession(session.id, paths);
    expect(loaded).not.toBeNull();
    expect(loaded!.lastTurnUsage).toBeUndefined();
  });
});
