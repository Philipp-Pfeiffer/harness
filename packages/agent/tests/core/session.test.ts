import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { HarnessPaths } from "@harness/core";
import {
  createSession,
  createSubAgentSession,
  createSessionId,
  recordTurn,
  endSession,
  readSession,
  listSessions,
  listSessionsWithDetails,
  turnsToMessages,
  calculateTurnCost,
  estimateContextTokens,
  loadSession,
  migrateLegacySessionFiles,
  SESSION_LOAD_WARN_THRESHOLD,
  SESSION_LOAD_SILENT_MAX,
  type SessionTurn,
  type ModelCost,
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

async function readJsonl(path: string): Promise<SessionTurn[]> {
  try {
    const raw = await readFile(path, "utf-8");
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as SessionTurn);
  } catch {
    return [];
  }
}

async function readIndex(paths: HarnessPaths): Promise<unknown[]> {
  try {
    const raw = await readFile(join(paths.sessions, "sessions.json"), "utf-8");
    return JSON.parse(raw) as unknown[];
  } catch {
    return [];
  }
}

function baseTurn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: "turn-1",
    role: "assistant",
    content: "Hello",
    userContent: "Hi",
    tokens: {
      input: 10,
      output: 5,
      total: 15,
      cacheRead: 0,
      cacheWrite: 0,
    },
    timing: {
      startedAt: "2026-06-25T10:00:00.000Z",
      latencyMs: 1234,
    },
    model: "minimax-m2.7",
    timestamp: "2026-06-25T10:00:01.000Z",
    ...overrides,
  };
}

describe("session", () => {
  let baseDir: string;
  let paths: HarnessPaths;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "harness-session-test-"));
    paths = makePaths(baseDir);
  });

  afterEach(() => {
    try {
      rmdirSync(baseDir, { recursive: true });
    } catch {
      // ignore cleanup failures
    }
  });

  describe("createSessionId", () => {
    it("returns a sortable timestamp-prefixed id with a short uuid suffix", () => {
      const id = createSessionId();
      expect(id).toMatch(/^\d{8}T\d{6}-[a-f0-9]{6}$/);
    });

    it("produces unique ids", () => {
      const ids = new Set(Array.from({ length: 20 }, createSessionId));
      expect(ids.size).toBe(20);
    });
  });

  describe("createSession", () => {
    it("creates a session, transcript file and index entry", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });

      expect(session.id).toMatch(/^\d{8}T\d{6}-[a-f0-9]{6}$/);
      expect(session.title).toBe("CLI Session");
      expect(session.model).toBe("minimax-m2.7");
      expect(session.status).toBe("active");
      expect(session.tokenTotals).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      const expectedDate = session.id.slice(0, 4) + "-" + session.id.slice(4, 6) + "-" + session.id.slice(6, 8);
      expect(session.transcriptPath).toBe(join(paths.sessions, expectedDate, `${session.id}.jsonl`));

      const turns = await readJsonl(session.transcriptPath);
      expect(turns).toHaveLength(0);

      const index = await readIndex(paths);
      expect(index).toHaveLength(1);
      expect(index[0]).toMatchObject({
        sessionId: session.id,
        model: "minimax-m2.7",
        title: "CLI Session",
        status: "active",
      });
    });

    it("uses the provided title", async () => {
      const session = await createSession(paths, {
        model: "minimax-m2.7",
        title: "Custom Session",
      });
      expect(session.title).toBe("Custom Session");
    });
  });

  describe("createSubAgentSession", () => {
    it("creates a session referencing its parent", async () => {
      const parent = await createSession(paths, { model: "minimax-m2.7" });
      const child = await createSubAgentSession(parent.id, paths, "minimax-m2.7");

      expect(child.parentSessionId).toBe(parent.id);
      expect(child.title).toBe(`Sub-Agent Session from ${parent.id}`);
      expect(child.model).toBe("minimax-m2.7");

      const index = await readIndex(paths);
      const childEntry = index.find((e: unknown) => (e as { sessionId: string }).sessionId === child.id);
      expect(childEntry).toMatchObject({
        parentSessionId: parent.id,
        title: `Sub-Agent Session from ${parent.id}`,
      });
    });
  });

  describe("recordTurn", () => {
    it("appends a turn to the transcript and updates the index", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      const turn = baseTurn({ id: "turn-1" });

      const updated = await recordTurn(session, turn, paths);

      const turns = await readJsonl(session.transcriptPath);
      expect(turns).toHaveLength(1);
      expect(turns[0].id).toBe("turn-1");
      expect(turns[0].content).toBe("Hello");

      expect(updated.tokenTotals).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(updated.lastActivityAt).toBe(turn.timestamp);

      const index = await readIndex(paths);
      expect(index).toHaveLength(1);
      expect((index[0] as { tokenTotals: typeof updated.tokenTotals }).tokenTotals).toEqual(updated.tokenTotals);
      expect((index[0] as { lastActivity: string }).lastActivity).toBe(turn.timestamp);
    });

    it("aggregates token totals across multiple turns", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });

      await recordTurn(session, baseTurn({ id: "t1", tokens: { input: 100, output: 50, total: 150, cacheRead: 10, cacheWrite: 5 } }), paths);
      const updated = await recordTurn(
        { ...session, tokenTotals: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheRead: 10, cacheWrite: 5 } },
        baseTurn({ id: "t2", tokens: { input: 200, output: 100, total: 300, cacheRead: 20, cacheWrite: 10 } }),
        paths
      );

      expect(updated.tokenTotals).toEqual({
        inputTokens: 300,
        outputTokens: 150,
        totalTokens: 450,
        cacheRead: 30,
        cacheWrite: 15,
      });
    });

    it("calculates and aggregates cost when model cost is provided", async () => {
      const session = await createSession(paths, { model: "test-model" });
      const cost: ModelCost = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 };
      const turn = baseTurn({
        id: "cost-turn",
        tokens: { input: 1_000_000, output: 500_000, total: 1_500_000, cacheRead: 100_000, cacheWrite: 50_000 },
        cost: calculateTurnCost(
          { input: 1_000_000, output: 500_000, total: 1_500_000, cacheRead: 100_000, cacheWrite: 50_000 },
          cost
        ),
      });

      const updated = await recordTurn(session, turn, paths);

      expect(updated.tokenTotals.costInput).toBe(1);
      expect(updated.tokenTotals.costOutput).toBe(1); // (500k / 1M) * 2
      expect(updated.tokenTotals.costCacheRead).toBe(0.05); // (100k / 1M) * 0.5
      expect(updated.tokenTotals.costCacheWrite).toBe(0.0125); // (50k / 1M) * 0.25
      expect(updated.tokenTotals.costTotal).toBeCloseTo(2.0625, 4);
    });

    it("writes JSONL lines deterministically parseable", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "a" }), paths);
      await recordTurn(session, baseTurn({ id: "b" }), paths);

      const raw = await readFile(session.transcriptPath, "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(JSON.parse(line)).toBeDefined();
      }
    });
  });

  describe("endSession", () => {
    it("marks the session as ended in the index", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      const ended = await endSession(session, paths);

      expect(ended.status).toBe("ended");

      const index = await readIndex(paths);
      expect(index).toHaveLength(1);
      expect((index[0] as { status: string }).status).toBe("ended");
    });
  });

  describe("readSession", () => {
    it("returns null for an unknown session id", async () => {
      const result = await readSession("nonexistent", paths);
      expect(result).toBeNull();
    });

    it("loads the session metadata and all turns", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      const turn1 = baseTurn({ id: "t1", content: "First" });
      const turn2 = baseTurn({ id: "t2", content: "Second" });
      await recordTurn(session, turn1, paths);
      const updated = await recordTurn(
        { ...session, tokenTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0 } },
        turn2,
        paths
      );

      const loaded = await readSession(updated.id, paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.session.sessionId).toBe(updated.id);
      expect(loaded!.turns).toHaveLength(2);
      expect(loaded!.turns[0].content).toBe("First");
      expect(loaded!.turns[1].content).toBe("Second");
    });

    it("skips corrupt transcript lines", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await writeFile(session.transcriptPath, `${JSON.stringify(baseTurn({ id: "good" }))}\n{ broken\n`, "utf-8");

      const loaded = await readSession(session.id, paths);
      expect(loaded!.turns).toHaveLength(1);
      expect(loaded!.turns[0].id).toBe("good");
    });
  });

  describe("listSessions", () => {
    it("lists all sessions", async () => {
      await createSession(paths, { model: "a" });
      await createSession(paths, { model: "b" });

      const sessions = await listSessions(paths);
      expect(sessions).toHaveLength(2);
    });

    it("filters sessions by date range", async () => {
      const s1 = await createSession(paths, { model: "a" });
      const s2 = await createSession(paths, { model: "b" });

      // Override created dates manually for deterministic testing.
      const index = await readIndex(paths);
      const updated = index.map((entry: unknown, idx: number) => ({
        ...(entry as object),
        created: idx === 0 ? "2026-06-24T12:00:00.000Z" : "2026-06-25T12:00:00.000Z",
        lastActivity: idx === 0 ? "2026-06-24T12:00:00.000Z" : "2026-06-25T12:00:00.000Z",
      }));
      await writeFile(join(paths.sessions, "sessions.json"), JSON.stringify(updated, null, 2), "utf-8");

      const filtered = await listSessions(paths, {
        from: "2026-06-25T00:00:00.000Z",
        to: "2026-06-25T23:59:59.000Z",
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].sessionId).toBe(s2.id);
    });
  });

  describe("turnsToMessages", () => {
    it("reconstructs messages from stored turn messages", () => {
      const turn = baseTurn({
        messages: [
          { role: "user", content: "Hi", timestamp: 1 },
          { role: "assistant", content: "Hello", timestamp: 2 },
        ] as unknown[],
      });
      const messages = turnsToMessages([turn as SessionTurn]);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
    });

    it("falls back to synthesized user and assistant messages when messages are not stored", () => {
      const turn = baseTurn();
      const messages = turnsToMessages([turn]);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect((messages[0] as { content: string }).content).toBe("Hi");
      expect(messages[1].role).toBe("assistant");
      // Assistant content is normalized to a content-block array (not a string),
      // so pi-ai's transformMessages can call .flatMap on it.
      expect((messages[1] as unknown as { content: Array<{ type: string; text: string }> }).content).toEqual([
        { type: "text", text: "Hello" },
      ]);
    });
  });

  describe("dated transcript layout", () => {
    it("writes new transcripts into YYYY-MM-DD/{id}.jsonl", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      const dateFolder = session.id.slice(0, 4) + "-" + session.id.slice(4, 6) + "-" + session.id.slice(6, 8);

      expect(session.transcriptPath).toBe(
        join(paths.sessions, dateFolder, `${session.id}.jsonl`),
      );

      await recordTurn(session, baseTurn({ id: "t1" }), paths);

      const loaded = await readSession(session.id, paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.turns).toHaveLength(1);
    });

    it("reads legacy flat transcripts when dated folder is missing", async () => {
      // Create index entry manually and place transcript at legacy path.
      const sessionId = "20260625T120000-legacy1";
      const legacyPath = join(paths.sessions, `${sessionId}.jsonl`);
      await mkdir(paths.sessions, { recursive: true });
      await writeFile(legacyPath, `${JSON.stringify(baseTurn({ id: "legacy-turn" }))}\n`, "utf-8");

      const indexRaw = await readFile(join(paths.sessions, "sessions.json"), "utf-8").catch(() => "[]");
      const index = JSON.parse(indexRaw) as unknown[];
      index.push({
        sessionId,
        created: "2026-06-25T12:00:00.000Z",
        lastActivity: "2026-06-25T12:00:00.000Z",
        model: "minimax-m2.7",
        tokenTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0 },
        title: "Legacy Session",
        status: "active",
      });
      await writeFile(join(paths.sessions, "sessions.json"), JSON.stringify(index, null, 2), "utf-8");

      const loaded = await readSession(sessionId, paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.turns).toHaveLength(1);
      expect(loaded!.turns[0].id).toBe("legacy-turn");
    });
  });

  describe("migrateLegacySessionFiles", () => {
    it("moves flat jsonl files into the correct dated folders", async () => {
      const sessionId = "20260624T120000-mig1";
      const legacyPath = join(paths.sessions, `${sessionId}.jsonl`);
      await mkdir(paths.sessions, { recursive: true });
      await writeFile(legacyPath, `${JSON.stringify(baseTurn({ id: "mig-turn" }))}\n`, "utf-8");

      const index = [{
        sessionId,
        created: "2026-06-24T12:00:00.000Z",
        lastActivity: "2026-06-24T12:00:00.000Z",
        model: "minimax-m2.7",
        tokenTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0 },
        title: "Migration Session",
        status: "active",
      }];
      await writeFile(join(paths.sessions, "sessions.json"), JSON.stringify(index, null, 2), "utf-8");

      const result = await migrateLegacySessionFiles(paths);
      expect(result.moved).toContain(sessionId);

      const loaded = await readSession(sessionId, paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.turns).toHaveLength(1);
    });
  });

  describe("estimateContextTokens", () => {
    it("estimates below silent max for small histories", () => {
      const messages = Array.from({ length: 10 }, () => ({
        role: "user" as const,
        content: "Hi there",
        timestamp: Date.now(),
      }));
      expect(estimateContextTokens(messages)).toBeLessThan(SESSION_LOAD_SILENT_MAX);
    });

    it("estimates above warn threshold for large repeated content", () => {
      const bigText = "x".repeat(210_000);
      const messages = [
        { role: "user" as const, content: bigText, timestamp: Date.now() },
      ];
      expect(estimateContextTokens(messages)).toBeGreaterThanOrEqual(SESSION_LOAD_WARN_THRESHOLD);
    });
  });

  describe("loadSession", () => {
    it("returns session, turns, and token estimate", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "t1", content: "Hello" }), paths);

      const loaded = await loadSession(session.id, paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.session.id).toBe(session.id);
      expect(loaded!.turns).toHaveLength(1);
      expect(loaded!.tokenEstimate).toBeGreaterThan(0);
    });

    it("returns null for an unknown session id", async () => {
      const loaded = await loadSession("nonexistent", paths);
      expect(loaded).toBeNull();
    });
  });

  describe("listSessionsWithDetails", () => {
    it("includes turn count and token estimate", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "t1" }), paths);
      await recordTurn(
        { ...session, tokenTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0 } },
        baseTurn({ id: "t2" }),
        paths,
      );

      const sessions = await listSessionsWithDetails(paths);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].turnCount).toBe(2);
      expect(sessions[0].tokenEstimate).toBeGreaterThan(0);
    });
  });
});
