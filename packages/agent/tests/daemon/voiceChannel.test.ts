import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection, type Socket } from "node:net";
import { VoiceChannel, voiceSessionId } from "../../src/daemon/voiceChannel.js";

const TEST_DIR = join(tmpdir(), `harness-voice-test-${process.pid}-${Date.now()}`);
const SOCKET_PATH = join(TEST_DIR, "voice.sock");

let channel: VoiceChannel;
const log = () => {};
const sessions = new Map<string, { ts: number; from: string }>();
const turns: Array<{ sessionId: string; text: string }> = [];
const ended: string[] = [];
const outboundStarted: Array<{ callId: string; sessionId: string }> = [];
const outboundEnded: Array<{ callId: string; sessionId: string; reason: string }> = [];
const callEndedEvents: Array<{ callId: string; sessionId: string; reason: string; isOutbound: boolean }> = [];

function makeCallbacks() {
  sessions.clear();
  turns.length = 0;
  ended.length = 0;
  outboundStarted.length = 0;
  outboundEnded.length = 0;
  callEndedEvents.length = 0;
  return {
    submitTurn: async (sessionId: string, callId: string, text: string) => {
      turns.push({ sessionId, text });
      return { finalResponse: `reply:${text}` };
    },
    resolveSession: async (callId: string, ts: number, from: string) => {
      const sessionId = voiceSessionId(ts);
      sessions.set(callId, { ts, from });
      return sessionId;
    },
    endSession: async (sessionId: string) => {
      ended.push(sessionId);
    },
    onOutboundCallStarted: async (callId: string, sessionId: string) => {
      outboundStarted.push({ callId, sessionId });
    },
    onCallEnded: async (callId: string, sessionId: string, reason: string, isOutbound: boolean) => {
      callEndedEvents.push({ callId, sessionId, reason, isOutbound });
    },
    onOutboundCallEnded: async (callId: string, sessionId: string, reason: string) => {
      outboundEnded.push({ callId, sessionId, reason });
    },
  };
}

async function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET_PATH);
    socket.on("connect", () => resolve(socket));
    socket.on("error", reject);
  });
}

function write(socket: Socket, msg: unknown): void {
  socket.write(JSON.stringify(msg) + "\n");
}

function readUntil(
  socket: Socket,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (predicate(parsed)) {
          clearTimeout(timer);
          socket.off("data", onData);
          resolve(parsed);
          return;
        }
      }
    };
    socket.on("data", onData);
  });
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  channel = new VoiceChannel({
    socketPath: SOCKET_PATH,
    log,
    callbacks: makeCallbacks(),
  });
  await channel.start();
});

afterEach(async () => {
  await channel.stop();
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("voiceSessionId", () => {
  it("maps a call-start ts to a voice session id", () => {
    expect(voiceSessionId(1699999999999)).toBe("voice-1699999999999");
  });
});

describe("VoiceChannel", () => {
  it("starts the socket, accepts call_started + transcript, replies with say", async () => {
    const socket = await connect();
    const replyPromise = readUntil(socket, (m) => m.type === "say");

    write(socket, { type: "call_started", callId: "c1", from: "+49123", direction: "inbound", ts: 111 });
    // Give the server a tick to process call_started before the transcript.
    await new Promise((r) => setTimeout(r, 50));
    write(socket, { type: "transcript", callId: "c1", text: "hallo" });

    const reply = await replyPromise;
    expect(reply).toMatchObject({ type: "say", callId: "c1", text: "reply:hallo" });

    expect(turns).toEqual([{ sessionId: "voice-111", text: "hallo" }]);
    socket.destroy();
  });

  it("hello resync registers active calls for later transcripts", async () => {
    const socket = await connect();
    write(socket, {
      type: "hello",
      activeCalls: [{ callId: "c2", from: "+49123", since: 222 }],
    });
    await new Promise((r) => setTimeout(r, 50));

    const replyPromise = readUntil(socket, (m) => m.type === "say");
    write(socket, { type: "transcript", callId: "c2", text: "weiter" });
    const reply = await replyPromise;
    expect(reply).toMatchObject({ type: "say", callId: "c2", text: "reply:weiter" });
    expect(turns).toEqual([{ sessionId: "voice-222", text: "weiter" }]);
    socket.destroy();
  });

  it("drops transcripts for unknown calls without crashing", async () => {
    const socket = await connect();
    write(socket, { type: "transcript", callId: "nope", text: "wer bist du" });
    await new Promise((r) => setTimeout(r, 50));
    expect(turns).toEqual([]);
    socket.destroy();
  });

  it("routes say to the socket that announced the call (reconnect scenario)", async () => {
    const socket1 = await connect();
    write(socket1, { type: "call_started", callId: "c3", from: "+49123", direction: "inbound", ts: 333 });
    await new Promise((r) => setTimeout(r, 50));

    // Simulate adapter reconnect: new socket sends hello for the same call.
    const socket2 = await connect();
    write(socket2, {
      type: "hello",
      activeCalls: [{ callId: "c3", from: "+49123", since: 333 }],
    });
    await new Promise((r) => setTimeout(r, 50));

    const replyOnSocket2 = readUntil(socket2, (m) => m.type === "say");
    write(socket2, { type: "transcript", callId: "c3", text: "nochmal" });
    const reply = await replyOnSocket2;
    expect(reply).toMatchObject({ type: "say", callId: "c3" });

    // socket1 must NOT receive the say (ownership moved to socket2).
    socket1.destroy();
    socket2.destroy();
  });

  it("call_ended ends the mapped session", async () => {
    const socket = await connect();
    write(socket, { type: "call_started", callId: "c4", from: "+49123", direction: "inbound", ts: 444 });
    await new Promise((r) => setTimeout(r, 50));
    write(socket, { type: "call_ended", callId: "c4", reason: "peer" });
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toEqual(["voice-444"]);
    socket.destroy();
  });

  it("call_error ends the mapped session", async () => {
    const socket = await connect();
    write(socket, { type: "call_started", callId: "c5", from: "+49123", direction: "inbound", ts: 555 });
    await new Promise((r) => setTimeout(r, 50));
    write(socket, { type: "call_error", callId: "c5", error: "boom" });
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toEqual(["voice-555"]);
    socket.destroy();
  });

  it("startCall broadcasts start_call to a connected adapter (no callId→socket mapping yet)", async () => {
    const socket = await connect();
    const replyPromise = readUntil(socket, (m) => m.type === "start_call");

    channel.startCall("ob-1", "4915110619636@s.whatsapp.net", "Hallo, hier ist Philipp.");

    const reply = await replyPromise;
    expect(reply).toMatchObject({
      type: "start_call",
      callId: "ob-1",
      jid: "4915110619636@s.whatsapp.net",
      briefing: "Hallo, hier ist Philipp.",
    });
    socket.destroy();
  });

  it("outbound call_started triggers onOutboundCallStarted (briefing seed)", async () => {
    channel.startCall("ob-2", "4915110619636@s.whatsapp.net", "Briefing");
    const socket = await connect();

    write(socket, { type: "call_started", callId: "ob-2", from: "4915110619636", direction: "outbound", ts: 777 });
    await new Promise((r) => setTimeout(r, 50));

    expect(outboundStarted).toEqual([{ callId: "ob-2", sessionId: "voice-777" }]);
    socket.destroy();
  });

  it("inbound call_started does NOT trigger onOutboundCallStarted", async () => {
    const socket = await connect();
    write(socket, { type: "call_started", callId: "c6", from: "+49123", direction: "inbound", ts: 888 });
    await new Promise((r) => setTimeout(r, 50));
    expect(outboundStarted).toEqual([]);
    socket.destroy();
  });

  it("outbound call_ended triggers onOutboundCallEnded with the reason", async () => {
    channel.startCall("ob-3", "4915110619636@s.whatsapp.net", "Briefing");
    const socket = await connect();
    write(socket, { type: "call_started", callId: "ob-3", from: "4915110619636", direction: "outbound", ts: 999 });
    await new Promise((r) => setTimeout(r, 50));

    write(socket, { type: "call_ended", callId: "ob-3", reason: "no-answer" });
    await new Promise((r) => setTimeout(r, 50));

    expect(outboundEnded).toEqual([{ callId: "ob-3", sessionId: "voice-999", reason: "ended: no-answer" }]);
    expect(ended).toEqual(["voice-999"]);
    socket.destroy();
  });

  it("call_ringing resolves the session, fires onInboundRinging, and delivers say before call_started", async () => {
    const ringing: Array<{ callId: string; from: string; ts: number }> = [];
    channel = new VoiceChannel({
      socketPath: SOCKET_PATH,
      log,
      callbacks: {
        ...makeCallbacks(),
        onInboundRinging: async (callId: string, from: string, ts: number) => {
          ringing.push({ callId, from, ts });
          // Die Begrüßung wird VOR call_started gesendet (Accept-After-Ready).
          channel.say(callId, "Hallo Philipp!");
        },
      },
    });
    await channel.start();

    const socket = await connect();
    const sayPromise = readUntil(socket, (m) => m.type === "say");
    write(socket, { type: "call_ringing", callId: "c8", from: "+49123", ts: 1414 });
    const say = await sayPromise;
    expect(say).toMatchObject({ type: "say", callId: "c8", text: "Hallo Philipp!" });
    expect(ringing).toEqual([{ callId: "c8", from: "+49123", ts: 1414 }]);
    expect(sessions.get("c8")).toEqual({ ts: 1414, from: "+49123" });

    // call_started für denselben Call nutzt die beim Ringing angelegte Session.
    write(socket, { type: "call_started", callId: "c8", from: "+49123", direction: "inbound", ts: 1414 });
    await new Promise((r) => setTimeout(r, 50));
    const replyPromise = readUntil(socket, (m) => m.type === "say");
    write(socket, { type: "transcript", callId: "c8", text: "hallo" });
    const reply = await replyPromise;
    expect(reply).toMatchObject({ type: "say", callId: "c8", text: "reply:hallo" });
    expect(turns).toEqual([{ sessionId: "voice-1414", text: "hallo" }]);
    socket.destroy();
  });

  it("call_ended fires onCallEnded for INBOUND calls too (generalized closing event)", async () => {
    const socket = await connect();
    write(socket, { type: "call_started", callId: "c7", from: "+49123", direction: "inbound", ts: 1212 });
    await new Promise((r) => setTimeout(r, 50));

    write(socket, { type: "call_ended", callId: "c7", reason: "peer" });
    await new Promise((r) => setTimeout(r, 50));

    expect(callEndedEvents).toEqual([
      { callId: "c7", sessionId: "voice-1212", reason: "ended: peer", isOutbound: false },
    ]);
    socket.destroy();
  });

  it("call_ended fires onCallEnded for OUTBOUND calls with isOutbound=true", async () => {
    channel.startCall("ob-4", "4915110619636@s.whatsapp.net", "Briefing");
    const socket = await connect();
    write(socket, { type: "call_started", callId: "ob-4", from: "4915110619636", direction: "outbound", ts: 1313 });
    await new Promise((r) => setTimeout(r, 50));

    write(socket, { type: "call_ended", callId: "ob-4", reason: "farewell" });
    await new Promise((r) => setTimeout(r, 50));

    expect(callEndedEvents).toEqual([
      { callId: "ob-4", sessionId: "voice-1313", reason: "ended: farewell", isOutbound: true },
    ]);
    socket.destroy();
  });
});
