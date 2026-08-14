/**
 * Voice turn flow in DaemonRuntime.
 *
 * Verifies the daemon-side session mapping (callId → voice-<ts>) and that a
 * transcript runs through the normal submit-turn path with the TTS-voice
 * system-prompt addendum injected via channelAddendumAsync.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTools, type Agent, type RunResult, type Model, type HarnessPaths, type Tool } from "@harness/core";
import type { Message } from "@mariozechner/pi-ai";
import type { Api } from "@mariozechner/pi-ai";
import { DaemonRuntime, voiceToolsForCall } from "../../src/daemon/runtime.js";
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
  voiceAgent: Agent | null;
  voiceTools: Tool[];
  resolveVoiceSession: (callId: string, ts: number, from: string) => Promise<string>;
  submitVoiceTurn: (sessionId: string, callId: string, text: string) => Promise<{ finalResponse: string }>;
  endVoiceSession: (sessionId: string) => Promise<void>;
  onInboundVoiceRinging: (callId: string, from: string, ts: number) => Promise<void>;
  injectSystemEvent: (event: { origin: string; text: string }, phoneOverride?: string) => Promise<void>;
  outboundVoiceCalls: Map<string, {
    number: string;
    name?: string;
    label?: string;
    briefing: string;
    requesterSessionId: string;
    callStartTs: number;
    phoneOverride?: string;
    briefingConsumed?: boolean;
  }>;
  outboundVoiceFallbacks: Map<string, ReturnType<typeof setTimeout>>;
  whatsappSessionToSource: Map<string, string>;
  currentVoiceSessionCaller: { sessionId: string; phoneOverride?: string } | null;
  onVoiceCallEnded: (callId: string, sessionId: string, reason: string, isOutbound: boolean) => Promise<void>;
  onOutboundVoiceCallStarted: (callId: string, sessionId: string) => Promise<void>;
  onOutboundVoiceCallEnded: (callId: string, sessionId: string, reason: string) => Promise<void>;
  voiceReportToMainSession: (text: string) => Promise<{ ok: boolean; error?: string }>;
  voiceHangUp: () => Promise<{ ok: boolean; error?: string }>;
  voiceChannel: { say(callId: string, text: string): void; endCall(callId: string, reason: string): void } | null;
  logger: { child(component: string): { info(msg: string): void; error(msg: string): void; warn(msg: string): void } };
  voiceCallSessionsBySession: Map<string, string>;
  pendingHangupSessions: Set<string>;
  pendingHangupFallbacks: Map<string, ReturnType<typeof setTimeout>>;
  afterVoiceFinalSay: (callId: string, sessionId: string, finalResponse: string) => void;
};

async function makeRuntime(opts: { addendumRecorder: (addendum: string | undefined) => void }) {
  const runtime = new DaemonRuntime();
  const internals = runtime as unknown as RuntimeInternals;
  const agentRunMessages: Array<{ sessionId: string; callId: string; text: string; addendum: string | undefined }> = [];
  internals.agent = {
    setModel() {},
    setSystemPrompt() {},
    async run(messages: Message[], options: { systemPromptAddendum?: string }): Promise<RunResult> {
      opts.addendumRecorder(options.systemPromptAddendum);
      agentRunMessages.push({ sessionId: "", callId: "", text: messages.at(-1)?.content?.toString() ?? "", addendum: options.systemPromptAddendum });
      // Mimic the real agent loop: it appends the assistant answer to the
      // passed message array (onInboundVoiceRinging relies on this to
      // persist the greeting).
      messages.push({ role: "assistant", content: "Antwort im Anruf", timestamp: Date.now() });
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
  internals.injectSystemEvent = async () => {};
  internals.whatsappSessionToSource = new Map();
  internals.currentVoiceSessionCaller = null;
  internals.outboundVoiceFallbacks = new Map();
  internals.voiceChannel = null;
  internals.outboundVoiceCalls = new Map();
  internals.voiceCallSessionsBySession = new Map();
  internals.pendingHangupSessions = new Set();
  internals.pendingHangupFallbacks = new Map();
  const voiceLogMocks = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  internals.logger = {
    child: () => voiceLogMocks,
  } as unknown as typeof internals.logger;

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

  return { runtime, internals, agentRunMessages, voiceLogMocks };
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

    const result = await internals.submitVoiceTurn("voice-123", "c1", "Hallo");

    expect(result.finalResponse).toBe("Antwort im Anruf");
    expect(capturedAddendum).toContain("TTS-verträglich");
    expect(capturedAddendum).not.toContain("Sticker");
  });

  it("voice tool list: no call_user, but hang_up + report_to_main_session stay", () => {
    const defaultTools = loadTools();
    // Sanity: the default tool set DOES include call_user — only the voice
    // session tool list must drop it (an active call must never start a
    // new outbound call).
    expect(defaultTools.some((t) => t.name === "call_user")).toBe(true);

    const voiceTools = voiceToolsForCall(defaultTools);
    expect(voiceTools.some((t) => t.name === "call_user")).toBe(false);
    expect(voiceTools.some((t) => t.name === "hang_up")).toBe(true);
    expect(voiceTools.some((t) => t.name === "report_to_main_session")).toBe(true);
  });

  it("submitVoiceTurn routes through the dedicated voice agent (no call_user)", async () => {
    const { internals, agentRunMessages } = await makeRuntime({ addendumRecorder: () => {} });
    const voiceRuns: string[] = [];
    const voiceTools = voiceToolsForCall(loadTools());
    internals.voiceTools = voiceTools;
    internals.voiceAgent = {
      setModel() {},
      setSystemPrompt() {},
      async run(messages: Message[]): Promise<RunResult> {
        voiceRuns.push(messages.at(-1)?.content?.toString() ?? "");
        messages.push({ role: "assistant", content: "Antwort im Voice-Agent", timestamp: Date.now() });
        return {
          aborted: false,
          turns: 1,
          finalMessage: "Antwort im Voice-Agent",
          toolCallCount: 0,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
        };
      },
    } as unknown as Agent;

    const result = await internals.submitVoiceTurn("voice-123", "c1", "Hallo");

    // Der Turn lief über den Voice-Agenten, nicht über den geteilten Agenten.
    expect(result.finalResponse).toBe("Antwort im Voice-Agent");
    expect(voiceRuns).toEqual(["Hallo"]);
    expect(agentRunMessages).toHaveLength(0);
    // Tool-Liste des Voice-Agenten: kein call_user, aber hang_up +
    // report_to_main_session.
    expect(internals.voiceTools.some((t) => t.name === "call_user")).toBe(false);
    expect(internals.voiceTools.some((t) => t.name === "hang_up")).toBe(true);
    expect(internals.voiceTools.some((t) => t.name === "report_to_main_session")).toBe(true);
  });

  it("endVoiceSession ends the session and clears the call mapping", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    await internals.endVoiceSession("voice-123");
    expect(internals.sessions.has("voice-123")).toBe(false);
    expect(internals.voiceCallSessions.has("c1")).toBe(false);
  });

  it("report_to_main_session delivers into the main WhatsApp session (event format)", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    const events: Array<{ origin: string; text: string; phone?: string }> = [];
    internals.injectSystemEvent = async (event, phone) => {
      events.push({ ...event, phone });
    };
    // Voice turn läuft gerade → Caller-Kontext ist gesetzt.
    internals.currentVoiceSessionCaller = { sessionId: "voice-123" };

    const result = await internals.voiceReportToMainSession("Der Termin ist am Freitag um 15 Uhr.");
    expect(result.ok).toBe(true);
    expect(events).toEqual([
      {
        origin: "Voice-Call",
        text: "[Voice-Call voice-123] Der Termin ist am Freitag um 15 Uhr.",
        phone: undefined,
      },
    ]);
  });

  it("report_to_main_session routes to the requesting chat for outbound (phoneOverride fallback)", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    const events: Array<{ origin: string; text: string; phone?: string }> = [];
    internals.injectSystemEvent = async (event, phone) => {
      events.push({ ...event, phone });
    };
    internals.currentVoiceSessionCaller = { sessionId: "voice-123", phoneOverride: "4915110619636" };

    const result = await internals.voiceReportToMainSession("Kurzbericht");
    expect(result.ok).toBe(true);
    expect(events[0]?.phone).toBe("4915110619636");
  });

  it("report_to_main_session fails cleanly without an active voice session", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    internals.currentVoiceSessionCaller = null;
    const result = await internals.voiceReportToMainSession("Test");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Keine aktive Voice-Session");
  });

  it("onVoiceCallEnded (inbound) injects the closing event with session + duration", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    const events: Array<{ origin: string; text: string; phone?: string }> = [];
    internals.injectSystemEvent = async (event, phone) => {
      events.push({ ...event, phone });
    };
    internals.whatsappSessionToSource.set("whatsapp-1", "491701234567");

    await internals.onVoiceCallEnded("c-in", "voice-1700000000000", "ended: peer", false);

    expect(events).toHaveLength(1);
    expect(events[0]?.origin).toBe("Voice-Call");
    expect(events[0]?.text).toContain("Anruf beendet");
    expect(events[0]?.text).toContain("Transkript: Session voice-1700000000000");
    expect(events[0]?.text).toMatch(/Dauer \d+s/);
    // Inbound → Owner-Main-Session (kein Phone-Override, Event-Bus resolvt selbst).
    expect(events[0]?.phone).toBeUndefined();
  });

  it("onVoiceCallEnded (outbound) routes the closing event to the requesting chat", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    const events: Array<{ origin: string; text: string; phone?: string }> = [];
    internals.injectSystemEvent = async (event, phone) => {
      events.push({ ...event, phone });
    };
    internals.whatsappSessionToSource.set("whatsapp-req", "4915110619636");
    internals.outboundVoiceCalls.set("ob-1", {
      number: "4915110619636",
      briefing: "Briefing",
      requesterSessionId: "whatsapp-req",
      callStartTs: 1700000000000,
    });

    await internals.onVoiceCallEnded("ob-1", "voice-1700000000000", "ended: farewell", true);

    expect(events).toHaveLength(1);
    expect(events[0]?.text).toContain("Anruf beendet");
    expect(events[0]?.phone).toBe("4915110619636");
  });

  it("outbound greeting: no turn before the first transcript, briefing attached to it", async () => {
    const { internals, agentRunMessages } = await makeRuntime({ addendumRecorder: () => {} });
    internals.outboundVoiceCalls.set("ob-2", {
      number: "4915110619636",
      briefing: "Briefing: Termin Freitag",
      requesterSessionId: "whatsapp-req",
      callStartTs: Date.now(),
    });
    internals.outboundVoiceFallbacks.set("ob-2", { unref() {}, hasRef() { return true; } } as ReturnType<typeof setTimeout>);

    // onOutboundCallStarted: KEIN sofortiger Turn.
    await internals.onOutboundVoiceCallStarted("ob-2", "voice-123");
    expect(agentRunMessages).toHaveLength(0);

    // Erstes Transkript: Briefing als Kontext + Outbound-Addendum + Präfix.
    await internals.submitVoiceTurn("voice-123", "ob-2", "Hallo?");
    expect(agentRunMessages).toHaveLength(1);
    expect(agentRunMessages[0]?.text).toContain("Du rufst 4915110619636 an.");
    expect(agentRunMessages[0]?.text).toContain("Briefing: Termin Freitag");
    expect(agentRunMessages[0]?.text).toContain("[Der Angerufene sagt:] Hallo?");
    expect(agentRunMessages[0]?.addendum).toContain("Du hast angerufen");
    expect(internals.outboundVoiceFallbacks.has("ob-2")).toBe(false);
    // Nur der ERSTE Turn trägt das Briefing.
    await internals.submitVoiceTurn("voice-123", "ob-2", "Nochmal?");
    expect(agentRunMessages[1]?.text).toBe("Nochmal?");
    expect(agentRunMessages[1]?.text).not.toContain("Briefing");
  });

  it("outbound greeting: 30s-Fallback eröffnet mit Hallo + Briefing", async () => {
    vi.useFakeTimers();
    try {
      const { internals, agentRunMessages } = await makeRuntime({ addendumRecorder: () => {} });
      internals.outboundVoiceCalls.set("ob-3", {
        number: "4915110619636",
        briefing: "Briefing: Paket abholen",
        requesterSessionId: "whatsapp-req",
        callStartTs: Date.now(),
      });

      await internals.onOutboundVoiceCallStarted("ob-3", "voice-123");
      expect(agentRunMessages).toHaveLength(0);
      const timer = internals.outboundVoiceFallbacks.get("ob-3")!;
      expect(timer).toBeDefined();

      // Timer feuert nach 30s → Opening-Turn mit Hallo + Briefing + Präfix.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(agentRunMessages).toHaveLength(1);
      expect(agentRunMessages[0]?.text).toContain("Du rufst 4915110619636 an.");
      expect(agentRunMessages[0]?.text).toContain("Hallo, hörst du mich?");
      expect(agentRunMessages[0]?.text).toContain("Briefing: Paket abholen");
      // Timer-Eintrag wurde beim Feuern entfernt.
      expect(internals.outboundVoiceFallbacks.has("ob-3")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("outbound greeting: erstes Transkript cancelt den Fallback-Timer", async () => {
    vi.useFakeTimers();
    try {
      const { internals, agentRunMessages } = await makeRuntime({ addendumRecorder: () => {} });
      internals.outboundVoiceCalls.set("ob-5", {
        number: "4915110619636",
        briefing: "Briefing",
        requesterSessionId: "whatsapp-req",
        callStartTs: Date.now(),
      });

      await internals.onOutboundVoiceCallStarted("ob-5", "voice-123");
      expect(internals.outboundVoiceFallbacks.has("ob-5")).toBe(true);

      // Transkript kommt nach 10s → Timer wird gecancelt, kein Fallback-Turn.
      await vi.advanceTimersByTimeAsync(10_000);
      await internals.submitVoiceTurn("voice-123", "ob-5", "Hallo?");
      expect(agentRunMessages).toHaveLength(1);
      expect(agentRunMessages[0]?.text).toContain("[Der Angerufene sagt:] Hallo?");
      expect(internals.outboundVoiceFallbacks.has("ob-5")).toBe(false);

      // Nach 30s kein zusätzlicher Fallback-Turn.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(agentRunMessages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("outbound context prefix: Name aus der Registry", async () => {
    await mkdir(join(TEST_DIR, "home"), { recursive: true });
    await writeFile(
      join(TEST_DIR, "home", "voice-registry.json"),
      JSON.stringify({ contacts: [{ number: "4915110619636", name: "Philipp" }] }),
      "utf-8",
    );

    const { internals, agentRunMessages } = await makeRuntime({ addendumRecorder: () => {} });
    internals.outboundVoiceCalls.set("ob-known", {
      number: "4915110619636",
      briefing: "Briefing: Termin",
      requesterSessionId: "whatsapp-req",
      callStartTs: Date.now(),
    });

    await internals.submitVoiceTurn("voice-123", "ob-known", "Hallo?");
    expect(agentRunMessages[0]?.text).toContain("Du rufst Philipp an.");
    expect(agentRunMessages[0]?.text).toContain("Briefing: Termin");
    expect(agentRunMessages[0]?.text).toContain("[Der Angerufene sagt:] Hallo?");
  });

  it("outbound context prefix: unbekannte Nummer → Nummer-Fallback", async () => {
    const { internals, agentRunMessages } = await makeRuntime({ addendumRecorder: () => {} });
    internals.outboundVoiceCalls.set("ob-unknown", {
      number: "4915110699999",
      briefing: "Briefing: Termin",
      requesterSessionId: "whatsapp-req",
      callStartTs: Date.now(),
    });

    await internals.submitVoiceTurn("voice-123", "ob-unknown", "Hallo?");
    expect(agentRunMessages[0]?.text).toContain("Du rufst 4915110699999 an.");
    expect(agentRunMessages[0]?.text).toContain("[Der Angerufene sagt:] Hallo?");
  });

  it("hang_up setzt nur das pendingHangup-Flag — kein sofortiges end_call", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    const endCalls: Array<{ callId: string; reason: string }> = [];
    internals.voiceChannel = {
      say() {},
      endCall: (callId, reason) => endCalls.push({ callId, reason }),
    };
    internals.currentVoiceSessionCaller = { sessionId: "voice-123" };
    internals.voiceCallSessionsBySession.set("voice-123", "c1");

    const result = await internals.voiceHangUp();
    expect(result.ok).toBe(true);
    // Kein sofortiges end_call — nur das Flag ist gesetzt.
    expect(endCalls).toEqual([]);
    expect(internals.pendingHangupSessions.has("voice-123")).toBe(true);
  });

  it("end_call kommt erst nach der finalen say (afterVoiceFinalSay)", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    const endCalls: Array<{ callId: string; reason: string }> = [];
    const says: Array<{ callId: string; text: string }> = [];
    internals.voiceChannel = {
      say: (callId, text) => says.push({ callId, text }),
      endCall: (callId, reason) => endCalls.push({ callId, reason }),
    };
    internals.currentVoiceSessionCaller = { sessionId: "voice-123" };
    internals.voiceCallSessionsBySession.set("voice-123", "c1");
    await internals.voiceHangUp();

    // Finale say wurde (vom VoiceChannel) bereits gepusht, danach finalisiert.
    internals.voiceChannel.say("c1", "Alles klar, tschüss!");
    internals.afterVoiceFinalSay("c1", "voice-123", "Alles klar, tschüss!");

    expect(endCalls).toEqual([{ callId: "c1", reason: "agent_requested" }]);
    // Reihenfolge-Garantie: say vor end_call.
    expect(says.length).toBeGreaterThan(0);
    expect(internals.pendingHangupSessions.has("voice-123")).toBe(false);
  });

  it("leerer Turn ohne finale Antwort → end_call nach kurzer Fallback-Frist", async () => {
    vi.useFakeTimers();
    try {
      const { internals } = await makeRuntime({ addendumRecorder: () => {} });
      const endCalls: Array<{ callId: string; reason: string }> = [];
      internals.voiceChannel = {
        say() {},
        endCall: (callId, reason) => endCalls.push({ callId, reason }),
      };
      internals.currentVoiceSessionCaller = { sessionId: "voice-123" };
      internals.voiceCallSessionsBySession.set("voice-123", "c1");
      await internals.voiceHangUp();

      internals.afterVoiceFinalSay("c1", "voice-123", "");
      expect(endCalls).toEqual([]);

      await vi.advanceTimersByTimeAsync(1500);
      expect(endCalls).toEqual([{ callId: "c1", reason: "agent_requested" }]);
      expect(internals.pendingHangupSessions.has("voice-123")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kein Doppel-end_call: finalize-Guard verhindert zweites end_call", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    const endCalls: Array<{ callId: string; reason: string }> = [];
    internals.voiceChannel = {
      say() {},
      endCall: (callId, reason) => endCalls.push({ callId, reason }),
    };
    internals.currentVoiceSessionCaller = { sessionId: "voice-123" };
    internals.voiceCallSessionsBySession.set("voice-123", "c1");
    await internals.voiceHangUp();

    internals.afterVoiceFinalSay("c1", "voice-123", "Tschüss!");
    // Zweiter Aufruf (z.B. konkurrierender Farewell-Pfad) darf nichts senden.
    internals.afterVoiceFinalSay("c1", "voice-123", "Tschüss!");

    expect(endCalls).toEqual([{ callId: "c1", reason: "agent_requested" }]);
  });

  it("hang_up fails cleanly without an active voice session", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    internals.currentVoiceSessionCaller = null;
    const result = await internals.voiceHangUp();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Keine aktive Voice-Session");
  });

  it("voice-timing: turn_start + say_sent werden beim Voice-Turn geloggt", async () => {
    const { internals, voiceLogMocks } = await makeRuntime({ addendumRecorder: () => {} });
    const result = await internals.submitVoiceTurn("voice-123", "c1", "Hallo");
    expect(result.finalResponse).toBe("Antwort im Anruf");
    expect(voiceLogMocks.info).toHaveBeenCalled();
    const calls = voiceLogMocks.info.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("voice-timing: turn_start"))).toBe(true);
    expect(calls.some((c) => c.includes("voice-timing: say_sent"))).toBe(true);
  });

  it("inbound ringing: Opening-Turn mit Registry-Name im System-Addendum, say VOR call_started", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    const says: Array<{ callId: string; text: string }> = [];
    internals.voiceChannel = {
      say: (callId, text) => says.push({ callId, text }),
      endCall() {},
    };
    // Registry: Nummer → Philipp (Tests laufen mit HARNESS_HOME=TEST_DIR/home).
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(internals.paths.home, { recursive: true });
    await writeFile(join(internals.paths.home, "voice-registry.json"),
      JSON.stringify({ contacts: [{ number: "4915112345678", name: "Philipp" }] }), "utf-8");

    // Kein Session-Mapping für diesen Call — onInboundVoiceRinging legt es an.
    expect(internals.voiceCallSessions.has("c-inbound")).toBe(false);
    await internals.onInboundVoiceRinging("c-inbound", "+4915112345678", 1700000000001);

    // Session wurde angelegt und der Opening-Turn geloggt.
    expect(internals.voiceCallSessions.get("c-inbound")).toBe("voice-1700000000001");
    const voiceLog = internals.logger.child("voice");
    const infoCalls = (voiceLog.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((c) => c.includes("inbound call ringing — Begrüßung mit Anrufer-Kontext: Philipp"))).toBe(true);
    expect(infoCalls.some((c) => c.includes("voice-timing: inbound_opening_say"))).toBe(true);
    // say ging raus (der Adapter puffert es bis zum Accept).
    expect(says).toEqual([{ callId: "c-inbound", text: "Antwort im Anruf" }]);
  });

  it("inbound ringing: unbekannte Nummer → Fallback auf die Roh-Nummer", async () => {
    const { internals } = await makeRuntime({ addendumRecorder: () => {} });
    await internals.onInboundVoiceRinging("c-unknown", "+499999999999", 1700000000002);
    const voiceLog = internals.logger.child("voice");
    const infoCalls = (voiceLog.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((c) => c.includes("inbound call ringing — Begrüßung mit Anrufer-Kontext: +499999999999"))).toBe(true);
  });

  it("inbound ringing: Opening-Turn bekommt synthetischen User-Turn und persistiert die Begrüßung", async () => {
    const addenda: Array<string | undefined> = [];
    const { internals, agentRunMessages } = await makeRuntime({ addendumRecorder: (a) => addenda.push(a) });
    internals.voiceChannel = { say() {}, endCall() {} };
    await internals.onInboundVoiceRinging("c-inbound", "+4915112345678", 1700000000003);

    // Der Agent lief genau EINMAL, und zwar mit dem synthetischen
    // User-Turn als letzter Message (kein leerer Opening-Turn mehr):
    expect(agentRunMessages).toHaveLength(1);
    expect(agentRunMessages[0]?.text).toContain("ruft gerade an");
    expect(agentRunMessages[0]?.text).toContain("+4915112345678");
    expect(agentRunMessages[0]?.addendum).toContain("ruft gerade an");
    expect(agentRunMessages[0]?.addendum).toContain("+4915112345678"); // Nummer im Addendum (keine Registry)
    expect(addenda.some((a) => a?.includes("TTS-verträglich"))).toBe(true);

    // Begrüßung wird persistiert: Session-Entry hat einen abgeschlossenen
    // Turn und die Messages enthalten User-Turn + Assistant-Antwort.
    const entry = internals.sessions.get(internals.voiceCallSessions.get("c-inbound")!);
    expect(entry?.turnsCompleted).toBe(1);
    expect(entry?.messages.some((m) => m.role === "user" && String(m.content).includes("[Eingehender Anruf] +4915112345678 ruft gerade an"))).toBe(true);
    expect(entry?.messages.some((m) => m.role === "assistant" && String(m.content).includes("Antwort im Anruf"))).toBe(true);
  });
});
