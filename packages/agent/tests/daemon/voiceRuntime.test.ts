/**
 * Voice turn flow in DaemonRuntime.
 *
 * Verifies the daemon-side session mapping (callId → voice-<ts>) and that a
 * transcript runs through the normal submit-turn path with the TTS-voice
 * system-prompt addendum injected via channelAddendumAsync.
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
import { createSession } from "../../src/core/session.js";

const TEST_DIR = join(tmpdir(), `harness-voice-runtime-${process.pid}-${Date.now()}`);

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
  paths: HarnessPaths;
  sessions: Map<string, SessionEntry>;
  voiceCallSessions: Map<string, string>;
  resolveVoiceSession: (callId: string, ts: number, from: string) => Promise<string>;
  submitVoiceTurn: (sessionId: string, text: string) => Promise<{ finalResponse: string }>;
  endVoiceSession: (sessionId: string) => Promise<void>;
};

async function makeRuntime(opts: { addendumRecorder: (addendum: string | undefined) => void }) {
  const runtime = new DaemonRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  internals.agent = {
    setModel() {},
    setSystemPrompt() {},
    async run(_messages: Message[], options: { systemPromptAddendum?: string }): Promise<RunResult> {
      opts.addendumRecorder(options.systemPromptAddendum);
      return {
        aborted: false,
        turns: 1,
        finalMessage: "Antwort im Anruf",
        toolCallCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
      };
    },
  } as unknown as Agent;
  internals.model = createFakeModel();
  internals.paths = resolveHarnessPaths();

  // Seed a voice session like resolveVoiceSession does (id = voice-<ts>).
  const session = await createSession(internals.paths, {
    id: "voice-123",
    model: "fake-default",
    title: "Voice: +49123",
    origin: "voice",
  });
  internals.sessions.set(session.id, {
    session,
    messages: [],
    turnsCompleted: 0,
    metricsRecorder: { recordTurn() {}, recordToolCall() {}, recordRetry() {} },
    origin: "voice",
    title: "Voice: +49123",
    createdAt: session.createdAt ?? new Date().toISOString(),
    lastActiveAt: session.lastActivityAt ?? new Date().toISOString(),
    profile: "default",
    mailbox: { push() {}, drainAll: () => [] },
    turnQueue: Promise.resolve(),
  });
  internals.voiceCallSessions.set("c1", "voice-123");

  return { runtime, internals };
}

describe("Voice turn flow in DaemonRuntime", () => {
  it("resolveVoiceSession maps a call to voice-<ts> and reuses an existing session", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    const sid = await internals.resolveVoiceSession("c-new", 999, "+49123");
    expect(sid).toBe("voice-999");

    // Re-resolving the same call returns the cached session.
    const sidAgain = await internals.resolveVoiceSession("c-new", 999, "+49123");
    expect(sidAgain).toBe("voice-999");
  });

  it("submitVoiceTurn runs the transcript and injects the TTS-voice addendum", async () => {
    let capturedAddendum: string | undefined;
    const { internals } = await makeRuntime({ addendumRecorder: (a) => (capturedAddendum = a) });

    const result = await internals.submitVoiceTurn("voice-123", "Hallo");

    expect(result.finalResponse).toBe("Antwort im Anruf");
    expect(capturedAddendum).toContain("TTS-verträglich");
    expect(capturedAddendum).not.toContain("Sticker");
  });

  it("endVoiceSession ends the session and clears the call mapping", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    await internals.endVoiceSession("voice-123");
    expect(internals.sessions.has("voice-123")).toBe(false);
    expect(internals.voiceCallSessions.has("c1")).toBe(false);
  });
});
