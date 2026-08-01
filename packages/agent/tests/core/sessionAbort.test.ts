import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { HarnessPaths } from "@harness/core";
import {
  createSession,
  recordTurn,
  extractAssistantTextFromMessages,
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

describe("session abort markers", () => {
  it("persists aborted and truncated fields on aborted turns", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-session-abort-"));
    const paths = makePaths(base);
    mkdirSync(paths.sessions, { recursive: true });
    mkdirSync(paths.index, { recursive: true });

    let session = await createSession(paths, { model: "test-model", title: "Abort test" });

    const messages = [
      { role: "user", content: "hello", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial output" }],
        stopReason: "aborted",
        timestamp: Date.now(),
      },
    ] as SessionTurn["messages"];

    const partial = extractAssistantTextFromMessages(messages ?? []);
    const turn: SessionTurn = {
      id: "turn-abort-1",
      role: "assistant",
      content: partial,
      userContent: "hello",
      tokens: { input: 1, output: 2, total: 3, cacheRead: 0, cacheWrite: 0 },
      timing: { startedAt: new Date().toISOString(), latencyMs: 10 },
      model: "test-model",
      timestamp: new Date().toISOString(),
      messages,
      aborted: true,
      truncated: true,
    };

    session = await recordTurn(session, turn, paths);
    const raw = await readFile(session.transcriptPath, "utf-8");
    const lines = raw.trim().split("\n");
    const persisted = JSON.parse(lines[lines.length - 1]!) as SessionTurn;

    expect(persisted.aborted).toBe(true);
    expect(persisted.truncated).toBe(true);
    expect(persisted.content).toBe("partial output");
  });
});
