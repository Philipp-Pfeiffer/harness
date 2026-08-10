/**
 * Progressive WhatsApp Outbound Tests.
 *
 * Verifies that a WhatsApp agent turn with the "text + tool + text" pattern
 * sends MULTIPLE messages during the turn — not only the final response at
 * turn end.
 *
 * The turn is driven through the daemon's submitWhatsAppTurn path with a
 * fake agent that emits agent events in the same order a real LLM stream
 * would: tokens, then a tool call, then tokens again. The fake channel
 * plugin records every sendMessage call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, RunResult, Model, HarnessPaths } from "@harness/core";
import type { Message } from "@mariozechner/pi-ai";
import type { Api } from "@mariozechner/pi-ai";
import { DaemonRuntime } from "../../src/daemon/runtime.js";
import { resolveHarnessPaths } from "@harness/core";
import type { ConfigModel } from "../../src/config.js";
import { createSession } from "../../src/core/session.js";

const TEST_DIR = join(tmpdir(), `harness-wa-progressive-${process.pid}-${Date.now()}`);

let savedHome: string | undefined;
let savedState: string | undefined;

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(join(TEST_DIR, "state", "logs"), { recursive: true });
  savedHome = process.env.HARNESS_HOME;
  savedState = process.env.HARNESS_STATE;
  process.env.HARNESS_HOME = join(TEST_DIR, "home");
  process.env.HARNESS_STATE = join(TEST_DIR, "state");
  vi.restoreAllMocks();
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHome;
  if (savedState === undefined) delete process.env.HARNESS_STATE;
  else process.env.HARNESS_STATE = savedState;
  await rm(TEST_DIR, { recursive: true, force: true });
});

function createFakeModel(): Model<Api> {
  return {
    name: "fake-default",
    id: "fake-default-id",
    provider: "fake",
    setApiKey() {},
  } as unknown as Model<Api>;
}

const MODELS: ConfigModel[] = [
  { provider: "openai", model: "gpt-5.2", alias: "GPT 5.2" },
];

type SessionEntry = {
  session: { id: string; transcriptPath: string; createdAt?: string; lastActivityAt?: string };
  messages: Message[];
  turnsCompleted: number;
  metricsRecorder: { recordTurn(): void; recordToolCall(): void; recordRetry(): void };
  origin: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  profile: string;
  mailbox: { push(): void; drainAll(): [] };
  turnQueue: Promise<unknown>;
};

type RuntimeInternals = {
  agent: Agent;
  model: Model<Api>;
  configModels: ConfigModel[];
  paths: HarnessPaths;
  sessions: Map<string, SessionEntry>;
  whatsappSessionToSource: Map<string, string>;
  whatsappSessions: Map<string, string>;
  channelPlugins: Map<string, { sendMessage: (jid: string, payload: { text?: string }) => Promise<void> }>;
  submitWhatsAppTurn: (sessionId: string, text: string, imageBlocks?: unknown[]) => Promise<{ finalResponse: string }>;
};

/**
 * Creates a runtime wired to a recording fake agent. The fake agent emits
 * the "text + tool + text" event pattern from its run() call so the
 * progressive-outbound hook is exercised end to end.
 */
async function makeRuntime(events: Array<{ type: string; text?: string; name?: string }>): Promise<{
  runtime: DaemonRuntime;
  internals: RuntimeInternals;
  sendMock: ReturnType<typeof vi.fn>;
  sessionId: string;
}> {
  const runtime = new DaemonRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  internals.agent = {
    setModel() {},
    setSystemPrompt() {},
    async run(_messages: Message[], options: { onEvent?: (e: { type: string; text?: string; name?: string }) => void }): Promise<RunResult> {
      for (const event of events) {
        options.onEvent?.(event);
        if (event.type === "tool_call_start") {
          // Tool execution runs between the text segments — the turn is
          // still active and the next text must be sent AFTER it.
          await new Promise((r) => setImmediate(r));
        }
      }
      return {
        aborted: false,
        turns: 1,
        finalMessage: "Finale Antwort",
        toolCallCount: 1,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
  } as unknown as Agent;
  internals.model = createFakeModel();
  internals.configModels = MODELS;
  internals.paths = resolveHarnessPaths();

  // Register a WhatsApp session with source mapping (same shape as the
  // selfModify/modelRef tests).
  const session = await createSession(internals.paths, {
    model: "fake-default",
    title: "WhatsApp: 491701234567",
    origin: "whatsapp",
  });
  internals.sessions.set(session.id, {
    session,
    messages: [],
    turnsCompleted: 0,
    metricsRecorder: { recordTurn() {}, recordToolCall() {}, recordRetry() {} },
    origin: "whatsapp",
    title: "WhatsApp: 491701234567",
    createdAt: session.createdAt ?? new Date().toISOString(),
    lastActiveAt: session.lastActivityAt ?? new Date().toISOString(),
    profile: "default",
    mailbox: { push() {}, drainAll: () => [] },
    turnQueue: Promise.resolve(),
  });
  internals.whatsappSessionToSource.set(session.id, "491701234567");
  internals.whatsappSessions.set("491701234567", session.id);

  const sendMock = vi.fn().mockResolvedValue(undefined);
  internals.channelPlugins.set("whatsapp", { sendMessage: sendMock });

  return { runtime, internals, sendMock, sessionId: session.id };
}

describe("WhatsApp progressive outbound", () => {
  it("sends text before tool calls immediately (text + tool + text pattern)", async () => {
    const { internals, sendMock, sessionId } = await makeRuntime([
      { type: "token", text: "Ich schaue kurz nach." },
      { type: "tool_call_start", name: "readFile" },
      { type: "tool_call_done", name: "readFile" },
      { type: "token", text: "\n\nErgebnis:" },
      { type: "token", text: " 42" },
    ]);

    const result = await internals.submitWhatsAppTurn(sessionId, "Wie viele Dateien?");

    expect(result.finalResponse).toBe("Finale Antwort");

    // The final response is sent by the inbound processor, not by the hook.
    // The progressive hook must have sent the interim text chunks already.
    const sentTexts = sendMock.mock.calls.map((c) => c[1]!.text);
    expect(sendMock).toHaveBeenCalledWith(
      "491701234567@s.whatsapp.net",
      expect.objectContaining({ text: expect.stringContaining("Ich schaue kurz nach.") }),
    );
    expect(sentTexts.join("")).toContain("Ich schaue kurz nach.");
    expect(sentTexts.join("")).toContain("Ergebnis: 42");
    expect(sentTexts.join("")).not.toContain("Finale Antwort");
  });

  it("sends nothing progressive when the agent produces no text before the final response", async () => {
    const { internals, sendMock, sessionId } = await makeRuntime([
      { type: "tool_call_start", name: "readFile" },
      { type: "tool_call_done", name: "readFile" },
    ]);

    const result = await internals.submitWhatsAppTurn(sessionId, "Nur Tool");

    expect(result.finalResponse).toBe("Finale Antwort");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("keeps the final response empty when no channel plugin is registered", async () => {
    const { internals, sessionId } = await makeRuntime([
      { type: "token", text: "Zwischentext" },
    ]);
    // Remove the plugin — the hook must be a no-op, turn still completes.
    internals.channelPlugins.delete("whatsapp");

    const result = await internals.submitWhatsAppTurn(sessionId, "Text");

    expect(result.finalResponse).toBe("Finale Antwort");
  });
});
