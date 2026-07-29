#!/usr/bin/env node
/**
 * Foreign consumer example: a standalone study assistant using the Harness
 * session store without starting the daemon.
 *
 * Usage:
 *   cd examples/foreign-consumer
 *   npm install
 *   node index.mjs
 *
 * The script stores sessions under ~/.lernassistent/ while keeping the main
 * Harness state directory untouched.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHarnessPaths } from "@harness/core";
import {
  createSession,
  recordTurn,
  readSession,
  listSessions,
  endSession,
} from "@harness/agent";

const paths = resolveHarnessPaths({
  home: join(homedir(), "harness"),
  state: join(homedir(), ".lernassistent"),
});

async function writeTwoTurns() {
  const session = await createSession(paths, {
    model: "minimax-m2.7",
    title: "Study Session",
  });
  console.log("created session", session.id);

  await recordTurn(session, {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "The capital of France is Paris.",
    userContent: "What is the capital of France?",
    tool_calls: [{ id: "tc-1", name: "web_search", arguments: { query: "capital of France" } }],
    tool_results: [{ toolCallId: "tc-1", name: "web_search", result: "Paris", isError: false }],
    tokens: { input: 20, output: 10, total: 30, cacheRead: 0, cacheWrite: 0 },
    timing: { startedAt: new Date().toISOString(), latencyMs: 123 },
    model: "minimax-m2.7",
    timestamp: new Date().toISOString(),
  }, paths);

  await recordTurn(
    { ...session, tokenTotals: { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheRead: 0, cacheWrite: 0 } },
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "6 * 7 = 42.",
      userContent: "Calculate 6 * 7",
      tool_calls: [{ id: "tc-2", name: "calculator", arguments: { expr: "6*7" } }],
      tool_results: [{ toolCallId: "tc-2", name: "calculator", result: "42", isError: false }],
      tokens: { input: 15, output: 5, total: 20, cacheRead: 0, cacheWrite: 0 },
      timing: { startedAt: new Date().toISOString(), latencyMs: 45 },
      model: "minimax-m2.7",
      timestamp: new Date().toISOString(),
    },
    paths,
  );

  await endSession(session, paths);
  return session.id;
}

async function readBack(sessionId) {
  const loaded = await readSession(sessionId, paths);
  if (!loaded) {
    throw new Error(`session ${sessionId} not found`);
  }
  console.log("session title:", loaded.session.title);
  console.log("turns:", loaded.turns.length);
  for (const turn of loaded.turns) {
    console.log("-", turn.userContent, "=>", turn.content);
    console.log("  tool_calls:", turn.tool_calls?.map((tc) => tc.name).join(", ") ?? "none");
    console.log("  tool_results:", turn.tool_results?.map((tr) => `${tr.name}=${tr.result}`).join(", ") ?? "none");
  }
  const all = await listSessions(paths);
  console.log("listed sessions:", all.length);
}

const mode = process.argv[2] ?? "write";

if (mode === "write") {
  const sessionId = await writeTwoTurns();
  console.log("write done; restart the process and run `node index.mjs read` to verify persistence");
  console.log("sessionId:", sessionId);
} else if (mode === "read") {
  const all = await listSessions(paths);
  if (all.length === 0) {
    console.error("no sessions found; run `node index.mjs write` first");
    process.exit(1);
  }
  // Read the most recently active session.
  const target = all.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))[0];
  if (!target) {
    console.error("no sessions found; run `node index.mjs write` first");
    process.exit(1);
  }
  await readBack(target.sessionId);
} else {
  console.error("usage: node index.mjs [write|read]");
  process.exit(1);
}
