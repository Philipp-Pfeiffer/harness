import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { HarnessPaths, resolveHarnessPaths } from "@harness/core";
import {
  createSession,
  createSubAgentSession,
  createSessionId,
  recordTurn,
  endSession,
  suspendSession,
  renameSession,
  deleteSession,
  readSession,
  listSessions,
  listSessionsWithDetails,
  turnsToMessages,
  calculateTurnCost,
  estimateContextTokens,
  extractToolData,
  loadSession,
  migrateLegacySessionFiles,
  countTurnsInTranscript,
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
      .map((line) => JSON.parse(line) as { type?: string } & SessionTurn)
      .filter((parsed) => parsed.type !== "session-end" && parsed.type !== "session-meta")
      .map((parsed) => parsed as SessionTurn);
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
      rmSync(baseDir, { recursive: true, force: true });
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

  describe("origin persistence", () => {
    it("persists the origin on the session and restores it on load", async () => {
      const session = await createSession(paths, {
        model: "minimax-m2.7",
        title: "WhatsApp: 491701234567",
        origin: "whatsapp",
      });
      expect(session.origin).toBe("whatsapp");

      // Origin is stored in the index entry.
      const index = await readIndex(paths);
      expect(index[0]).toMatchObject({ sessionId: session.id, origin: "whatsapp" });

      // Simulated daemon restart: loadSession reads the persisted origin back.
      const loaded = await loadSession(session.id, paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.session.origin).toBe("whatsapp");
    });

    it("treats sessions without an origin as api (fallback for old sessions)", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      expect(session.origin).toBeUndefined();

      const loaded = await loadSession(session.id, paths);
      expect(loaded).not.toBeNull();
      // Sessions created before the origin field existed have no origin —
      // callers fall back to "api".
      expect(loaded!.session.origin).toBeUndefined();

      const listed = await listSessions(paths);
      expect(listed[0]!.origin).toBeUndefined();
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
      // session-meta + 2 turns
      expect(lines).toHaveLength(3);
      const meta = JSON.parse(lines[0]!) as { type?: string };
      expect(meta.type).toBe("session-meta");
      for (const line of lines.slice(1)) {
        expect(JSON.parse(line)).toBeDefined();
      }
    });
  });

  describe("endSession", () => {
    it("marks the session as ended in the index with endedAt", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      const ended = await endSession(session, paths);

      expect(ended.status).toBe("ended");
      expect(ended.endedAt).toBeDefined();

      const index = await readIndex(paths);
      expect(index).toHaveLength(1);
      const entry = index[0] as { status: string; endedAt?: string };
      expect(entry.status).toBe("ended");
      expect(entry.endedAt).toBeDefined();
    });

    it("writes a session-end marker to the transcript", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "t1" }), paths);
      await endSession(session, paths);

      const raw = await readFile(session.transcriptPath, "utf-8");
      const lines = raw.trim().split("\n");
      const lastLine = JSON.parse(lines[lines.length - 1]!) as { type?: string };
      expect(lastLine.type).toBe("session-end");
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

    it("reconstructs index entry from transcript when index is corrupt", async () => {
      // Simulate a corrupt sessions.json that yields an empty index.
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "t1", content: "First" }), paths);
      await recordTurn(
        { ...session, tokenTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0 } },
        baseTurn({ id: "t2", content: "Second" }),
        paths,
      );
      await writeFile(join(paths.sessions, "sessions.json"), "{ not valid json", "utf-8");

      const loaded = await readSession(session.id, paths);
      expect(loaded).not.toBeNull();
      // Index entry reconstructed from transcript, not from the corrupt index.
      expect(loaded!.session.sessionId).toBe(session.id);
      expect(loaded!.session.model).toBe("minimax-m2.7");
      expect(loaded!.session.status).toBe("idle");
      // Token totals reconstructed from turns.
      expect(loaded!.session.tokenTotals.inputTokens).toBe(20);
      expect(loaded!.session.tokenTotals.outputTokens).toBe(10);
      // Turns still readable.
      expect(loaded!.turns).toHaveLength(2);
    });
  });

  describe("listSessions", () => {
    it("lists all sessions", async () => {
      await createSession(paths, { model: "a" });
      await createSession(paths, { model: "b" });

      const sessions = await listSessions(paths);
      expect(sessions).toHaveLength(2);
    });

    it("filters sessions by lastActivity range", async () => {
      const s1 = await createSession(paths, { model: "a" });
      const s2 = await createSession(paths, { model: "b" });

      // Override lastActivity manually for deterministic testing.
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

    it("filters on lastActivity, not created — session from previous day active today is included", async () => {
      const s1 = await createSession(paths, { model: "a" });

      // Session created yesterday, but lastActivity is today
      const index = await readIndex(paths);
      const updated = index.map((entry: unknown) => ({
        ...(entry as object),
        created: "2026-06-24T08:00:00.000Z",
        lastActivity: "2026-06-25T14:00:00.000Z",
      }));
      await writeFile(join(paths.sessions, "sessions.json"), JSON.stringify(updated, null, 2), "utf-8");

      const filtered = await listSessions(paths, {
        from: "2026-06-25T00:00:00.000Z",
        to: "2026-06-25T23:59:59.000Z",
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].sessionId).toBe(s1.id);
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

  describe("suspendSession", () => {
    it("marks the session as suspended without an end marker", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "t1" }), paths);
      const suspended = await suspendSession(session, paths);

      expect(suspended.status).toBe("suspended");
      expect(suspended.endedAt).toBeUndefined();

      // No end marker in the transcript
      const raw = await readFile(session.transcriptPath, "utf-8");
      const lines = raw.trim().split("\n");
      for (const line of lines) {
        const parsed = JSON.parse(line) as { type?: string };
        expect(parsed.type).not.toBe("session-end");
      }
    });

    it("suspended session is distinct from ended in the index", async () => {
      const s1 = await createSession(paths, { model: "a" });
      await suspendSession(s1, paths);
      const s2 = await createSession(paths, { model: "b" });
      await endSession(s2, paths);

      const sessions = await listSessions(paths);
      const s1Entry = sessions.find((s) => s.sessionId === s1.id);
      const s2Entry = sessions.find((s) => s.sessionId === s2.id);
      expect(s1Entry?.status).toBe("suspended");
      expect(s1Entry?.endedAt).toBeUndefined();
      expect(s2Entry?.status).toBe("ended");
      expect(s2Entry?.endedAt).toBeDefined();
    });
  });

  describe("readSession skips end markers", () => {
    it("does not include session-end markers in turns", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "t1" }), paths);
      await endSession(session, paths);

      const loaded = await readSession(session.id, paths);
      expect(loaded!.turns).toHaveLength(1);
      expect(loaded!.turns[0].id).toBe("t1");
    });
  });

  describe("extractToolData", () => {
    it("extracts tool calls and results from a message slice", () => {
      const messages = [
        { role: "user" as const, content: "read foo.txt", timestamp: 1 },
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "Reading file..." },
            { type: "toolCall" as const, id: "tc-1", name: "readFile", arguments: { path: "foo.txt" } },
          ],
          timestamp: 2,
        } as never,
        {
          role: "toolResult" as const,
          toolCallId: "tc-1",
          toolName: "readFile",
          content: [{ type: "text" as const, text: "file contents here" }],
          isError: false,
          timestamp: 3,
        } as never,
      ];

      const result = extractToolData(messages);
      expect(result.tool_calls).toHaveLength(1);
      expect(result.tool_calls[0]).toEqual({
        id: "tc-1",
        name: "readFile",
        arguments: { path: "foo.txt" },
      });
      expect(result.tool_results).toHaveLength(1);
      expect(result.tool_results[0]).toEqual({
        toolCallId: "tc-1",
        name: "readFile",
        result: "file contents here",
        isError: false,
      });
    });

    it("returns empty arrays for a slice without tool calls", () => {
      const messages = [
        { role: "user" as const, content: "hello", timestamp: 1 },
        { role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 2 } as never,
      ];
      const result = extractToolData(messages);
      expect(result.tool_calls).toHaveLength(0);
      expect(result.tool_results).toHaveLength(0);
    });
  });

  describe("tool data roundtrip via recordTurn + readSession", () => {
    it("persists and retrieves tool_calls and tool_results", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      const turn = baseTurn({
        id: "t1",
        tool_calls: [
          { id: "tc-1", name: "readFile", arguments: { path: "foo.txt" } },
        ],
        tool_results: [
          { toolCallId: "tc-1", name: "readFile", result: "contents", isError: false },
        ],
      });
      await recordTurn(session, turn, paths);

      const loaded = await readSession(session.id, paths);
      expect(loaded!.turns).toHaveLength(1);
      expect(loaded!.turns[0].tool_calls).toHaveLength(1);
      expect(loaded!.turns[0].tool_calls![0]).toEqual({
        id: "tc-1",
        name: "readFile",
        arguments: { path: "foo.txt" },
      });
      expect(loaded!.turns[0].tool_results).toHaveLength(1);
      expect(loaded!.turns[0].tool_results![0]).toEqual({
        toolCallId: "tc-1",
        name: "readFile",
        result: "contents",
        isError: false,
      });
    });
  });

  describe("countTurnsInTranscript skips end markers", () => {
    it("counts only turns, not end markers", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "t1" }), paths);
      await recordTurn(
        { ...session, tokenTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0 } },
        baseTurn({ id: "t2" }),
        paths,
      );
      await endSession(session, paths);

      const count = await countTurnsInTranscript(session.id, paths);
      expect(count).toBe(2);
    });
  });

  describe("renameSession", () => {
    it("updates the title in the index and the transcript", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7", title: "Old Title" });
      const renamed = await renameSession(session, "New Title", paths);

      expect(renamed.title).toBe("New Title");

      const listed = await listSessions(paths);
      expect(listed[0].title).toBe("New Title");

      const raw = await readFile(session.transcriptPath, "utf-8");
      const lines = raw.trim().split("\n");
      const lastLine = JSON.parse(lines[lines.length - 1]!) as { type?: string; title?: string };
      expect(lastLine.type).toBe("session-meta");
      expect(lastLine.title).toBe("New Title");
    });

    it("title survives an index rebuild", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7", title: "Original" });
      await recordTurn(session, baseTurn({ id: "t1" }), paths);
      await renameSession(session, "Renamed", paths);

      // Corrupt the index.
      await writeFile(join(paths.sessions, "sessions.json"), "{ broken", "utf-8");

      const listed = await listSessions(paths);
      const rebuilt = listed.find((s) => s.sessionId === session.id);
      expect(rebuilt).toBeDefined();
      expect(rebuilt!.title).toBe("Renamed");
    });
  });

  describe("deleteSession", () => {
    it("soft-deletes by moving the transcript to deleted/", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "t1" }), paths);

      await deleteSession(session.id, paths);

      const listed = await listSessions(paths);
      expect(listed).toHaveLength(0);

      const deletedFiles = await readdir(join(paths.sessions, "deleted"));
      expect(deletedFiles.length).toBeGreaterThan(0);
      expect(deletedFiles[0]).toBe(`${session.id}.jsonl`);
    });

    it("permanently deletes when requested", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await deleteSession(session.id, paths, { permanent: true });

      const listed = await listSessions(paths);
      expect(listed).toHaveLength(0);
      expect(await readFile(session.transcriptPath, "utf-8").then(() => true, () => false)).toBe(false);
    });

    it("returns true on first delete and false when the session does not exist", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "t1" }), paths);

      const first = await deleteSession(session.id, paths);
      expect(first).toBe(true);

      const second = await deleteSession(session.id, paths);
      expect(second).toBe(false);
    });
  });

  describe("foreign consumer with custom state root", () => {
    it("ignores HARNESS_STATE and XDG_STATE_HOME when state is passed explicitly", () => {
      const originalState = process.env.HARNESS_STATE;
      const originalXdg = process.env.XDG_STATE_HOME;
      try {
        process.env.HARNESS_STATE = "/env/state";
        process.env.XDG_STATE_HOME = "/xdg/state";

        const paths = resolveHarnessPaths({ home: "/opt/home", state: "/opt/state" });
        expect(paths.state).toBe("/opt/state");
        expect(paths.sessions).toBe("/opt/state/sessions");
      } finally {
        if (originalState === undefined) delete process.env.HARNESS_STATE;
        else process.env.HARNESS_STATE = originalState;
        if (originalXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = originalXdg;
      }
    });

    it("writes and reads a turn with tool data like an external app", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7", title: "Study Session" });
      const turn = baseTurn({
        id: "t1",
        content: "The answer is 42.",
        userContent: "What is the answer?",
        tool_calls: [{ id: "tc-1", name: "calculator", arguments: { expr: "6*7" } }],
        tool_results: [{ toolCallId: "tc-1", name: "calculator", result: "42", isError: false }],
      });
      await recordTurn(session, turn, paths);

      const loaded = await readSession(session.id, paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.turns).toHaveLength(1);
      expect(loaded!.turns[0].tool_calls).toEqual([{ id: "tc-1", name: "calculator", arguments: { expr: "6*7" } }]);
      expect(loaded!.turns[0].tool_results).toEqual([{ toolCallId: "tc-1", name: "calculator", result: "42", isError: false }]);
    });
  });

  describe("two stores with different roots are isolated", () => {
    it("keeps sessions in separate state directories", async () => {
      const pathsA = makePaths(join(baseDir, "store-a"));
      const pathsB = makePaths(join(baseDir, "store-b"));

      const sessionA = await createSession(pathsA, { model: "a", title: "Store A" });
      const sessionB = await createSession(pathsB, { model: "b", title: "Store B" });

      const listedA = await listSessions(pathsA);
      const listedB = await listSessions(pathsB);

      expect(listedA.map((s) => s.sessionId)).toEqual([sessionA.id]);
      expect(listedB.map((s) => s.sessionId)).toEqual([sessionB.id]);
      expect(listedA[0].title).toBe("Store A");
      expect(listedB[0].title).toBe("Store B");
    });
  });

  describe("corrupt index keeps sessions findable", () => {
    it("rebuilds the index from transcripts and keeps all sessions visible", async () => {
      const s1 = await createSession(paths, { model: "a", title: "One" });
      const s2 = await createSession(paths, { model: "b", title: "Two" });
      await recordTurn(s1, baseTurn({ id: "t1" }), paths);
      await recordTurn(s2, baseTurn({ id: "t2" }), paths);

      await writeFile(join(paths.sessions, "sessions.json"), "{ not json", "utf-8");

      const listed = await listSessions(paths);
      expect(listed).toHaveLength(2);
      expect(listed.map((s) => s.title).sort()).toEqual(["One", "Two"]);

      const backups = await readdir(paths.sessions);
      expect(backups.some((f) => f.startsWith("sessions.json.corrupt-"))).toBe(true);
    });

    it("skips individual corrupt entries and keeps valid ones", async () => {
      const s1 = await createSession(paths, { model: "a", title: "Valid" });
      await recordTurn(s1, baseTurn({ id: "t1" }), paths);

      const corruptEntry = { sessionId: "bad", notValid: true };
      await writeFile(join(paths.sessions, "sessions.json"), JSON.stringify([sessionToIndexEntryForTest(s1), corruptEntry]), "utf-8");

      const listed = await listSessions(paths);
      expect(listed).toHaveLength(1);
      expect(listed[0].sessionId).toBe(s1.id);
    });
  });

  describe("missing index rebuilds from transcripts", () => {
    it("rebuilds the index when sessions.json is gone", async () => {
      const s1 = await createSession(paths, { model: "a", title: "" });
      const s2 = await createSession(paths, { model: "b", title: "Two" });
      await recordTurn(s1, baseTurn({ id: "t1" }), paths);
      await recordTurn(s2, baseTurn({ id: "t2" }), paths);

      await unlink(join(paths.sessions, "sessions.json"));

      const listed = await listSessions(paths);
      expect(listed).toHaveLength(2);
      expect(listed.map((s) => s.sessionId).sort()).toEqual([s1.id, s2.id].sort());
    });

    it("returns an empty list for a fresh directory without transcripts", async () => {
      await mkdir(paths.sessions, { recursive: true });
      const listed = await listSessions(paths);
      expect(listed).toHaveLength(0);
      expect(await readFile(join(paths.sessions, "sessions.json"), "utf-8").then(() => true, () => false)).toBe(false);
    });
  });

  describe("resume after process restart", () => {
    it("loads a session and its turns in a fresh process context", async () => {
      const session = await createSession(paths, { model: "minimax-m2.7" });
      await recordTurn(session, baseTurn({ id: "t1", content: "Remember BANANA" }), paths);

      // Simulate a fresh process: loadSession uses only paths and disk.
      const loaded = await loadSession(session.id, paths);
      expect(loaded).not.toBeNull();
      expect(loaded!.session.id).toBe(session.id);
      expect(loaded!.turns).toHaveLength(1);
      expect(loaded!.turns[0].content).toBe("Remember BANANA");
    });
  });
});

function sessionToIndexEntryForTest(session: { id: string; title: string; createdAt: string; lastActivityAt: string; model: string; tokenTotals: { inputTokens: number; outputTokens: number; totalTokens: number; cacheRead: number; cacheWrite: number; }; status: string; }): Record<string, unknown> {
  return {
    sessionId: session.id,
    created: session.createdAt,
    lastActivity: session.lastActivityAt,
    model: session.model,
    tokenTotals: session.tokenTotals,
    title: session.title,
    status: session.status,
  };
}
