import { createServer, type Server, type Socket } from "node:net";
import { unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  VoiceInboundMessage,
  VoiceOutboundMessage,
  VoiceActiveCall,
} from "./types.js";

const DELIMITER = "\n";
const ENCODING = "utf-8";

type LogFn = (msg: string, level?: "info" | "warn" | "error") => void;

/** callId → Session-ID (`voice-<ts>`). */
export function voiceSessionId(callStartTs: number): string {
  return `voice-${callStartTs}`;
}

export interface VoiceChannelCallbacks {
  /**
   * Submit a transcript as a normal agent turn in the given session.
   * `callId` lets the daemon route progressive `say` messages mid-turn.
   * Returns the agent's final response text (empty when aborted).
   */
  submitTurn: (sessionId: string, callId: string, text: string) => Promise<{ finalResponse: string }>;
  /** Resolve or create a fresh session for a call; returns its session id. */
  resolveSession: (callId: string, callStartTs: number, from: string) => Promise<string>;
  /** End the session for a call (idempotent). */
  endSession: (sessionId: string) => Promise<void>;
  /**
   * Trigger the initial briefing turn for an outbound call once the adapter
   * reported `call_started` (direction=outbound). The daemon seeds the
   * briefing and speaks the greeting without waiting for user input.
   */
  onOutboundCallStarted?: (callId: string, sessionId: string) => Promise<void>;
  /**
   * Notify the daemon that an outbound call ended, so it can inject a
   * system event into the originating chat session. Only fired for calls
   * the daemon started via `startCall()`.
   */
  onOutboundCallEnded?: (callId: string, sessionId: string, reason: string) => Promise<void>;
}

export interface VoiceChannelOptions {
  socketPath: string;
  log: LogFn;
  callbacks: VoiceChannelCallbacks;
}

/**
 * Daemon-side voice channel: NDJSON Unix-socket server that bridges the
 * WhatsApp voice adapter to the normal session store.
 *
 * The adapter is a dumb audio adapter — it sends transcripts (`transcript`)
 * and call lifecycle events; the daemon owns the agent, sessions, persona,
 * memory, tools and skills. Each call is a session `voice-<callStartTs>`
 * with origin "voice"; transcripts run through the regular submit-turn queue.
 *
 * Daemon → adapter messages (`say`, `end_call`) are pushed to the socket
 * that announced the target `callId`.
 */
export class VoiceChannel {
  private server: Server | null = null;
  private readonly callToSession = new Map<string, string>();
  private readonly callToSocket = new Map<string, Socket>();
  private readonly sockets = new Set<Socket>();
  /** callIds the daemon initiated (outbound) — trigger the outbound callbacks. */
  private readonly outboundCallIds = new Set<string>();

  constructor(private readonly opts: VoiceChannelOptions) {}

  async start(): Promise<void> {
    await unlink(this.opts.socketPath).catch(() => {});
    await mkdir(dirname(this.opts.socketPath), { recursive: true });

    this.server = createServer((socket) => this.onConnection(socket));
    this.server.on("error", (err) => {
      this.opts.log(`voice IPC server error: ${err.message}`, "error");
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(this.opts.socketPath, () => resolve());
    });
    this.opts.log(`voice IPC server listening on ${this.opts.socketPath}`);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.callToSocket.clear();
    this.outboundCallIds.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    await unlink(this.opts.socketPath).catch(() => {});
  }

  /** Push a `say` (agent response) to the socket that owns `callId`. */
  say(callId: string, text: string): void {
    this.send({ type: "say", callId, text }, callId);
  }

  /** Push an `end_call` (bot-side hangup) to the socket that owns `callId`. */
  endCall(callId: string, reason: string): void {
    this.send({ type: "end_call", callId, reason }, callId);
  }

  /**
   * Start an outbound call: send `start_call` to the adapter. The adapter
   * dials and reports `call_started` (direction=outbound); the daemon then
   * seeds the briefing and the first spoken turn.
   *
   * A new outbound call has no callId→socket mapping yet (the adapter has not
   * announced it), so `start_call` is sent to any connected adapter socket.
   */
  startCall(callId: string, jid: string, briefing: string): void {
    this.outboundCallIds.add(callId);
    this.broadcast({ type: "start_call", callId, jid, briefing });
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString(ENCODING);
      const lines = buffer.split(DELIMITER);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        void this.handleLine(socket, trimmed);
      }
    });

    socket.on("error", () => {
      // Client disconnected abruptly — drop its mappings.
    });

    socket.on("close", () => {
      this.sockets.delete(socket);
      for (const [callId, owner] of this.callToSocket) {
        if (owner === socket) this.callToSocket.delete(callId);
      }
    });
  }

  private async handleLine(socket: Socket, raw: string): Promise<void> {
    let msg: VoiceInboundMessage;
    try {
      msg = JSON.parse(raw) as VoiceInboundMessage;
    } catch (err) {
      this.opts.log(`voice: unparseable line: ${(err as Error).message}`, "warn");
      return;
    }

    switch (msg.type) {
      case "hello":
        await this.handleHello(socket, msg.activeCalls ?? []);
        break;
      case "call_started": {
        const sessionId = await this.opts.callbacks.resolveSession(
          msg.callId,
          msg.ts,
          msg.from,
        );
        this.callToSession.set(msg.callId, sessionId);
        this.callToSocket.set(msg.callId, socket);
        if (msg.direction === "outbound" && this.outboundCallIds.has(msg.callId)) {
          await this.opts.callbacks.onOutboundCallStarted?.(msg.callId, sessionId);
        }
        break;
      }
      case "transcript": {
        const sessionId = this.callToSession.get(msg.callId);
        if (!sessionId) {
          this.opts.log(`voice: transcript for unknown call ${msg.callId} — dropped`, "warn");
          return;
        }
        this.callToSocket.set(msg.callId, socket);
        const { finalResponse } = await this.opts.callbacks.submitTurn(sessionId, msg.callId, msg.text);
        if (finalResponse) {
          this.say(msg.callId, finalResponse);
        }
        break;
      }
      case "call_ended":
        await this.finishCall(msg.callId, `ended: ${msg.reason}`);
        break;
      case "call_error":
        await this.finishCall(msg.callId, `error: ${msg.error}`);
        break;
      default:
        this.opts.log(`voice: unknown message type`, "warn");
    }
  }

  private async handleHello(socket: Socket, activeCalls: VoiceActiveCall[]): Promise<void> {
    for (const call of activeCalls) {
      const sessionId = await this.opts.callbacks.resolveSession(
        call.callId,
        call.since,
        call.from,
      );
      this.callToSession.set(call.callId, sessionId);
      this.callToSocket.set(call.callId, socket);
    }
  }

  private async finishCall(callId: string, reason: string): Promise<void> {
    const sessionId = this.callToSession.get(callId);
    if (!sessionId) return;
    const isOutbound = this.outboundCallIds.has(callId);
    this.callToSession.delete(callId);
    this.callToSocket.delete(callId);
    this.outboundCallIds.delete(callId);
    this.opts.log(`voice: call ${callId} finished (${reason})`);
    await this.opts.callbacks.endSession(sessionId);
    if (isOutbound) {
      await this.opts.callbacks.onOutboundCallEnded?.(callId, sessionId, reason);
    }
  }

  private send(message: VoiceOutboundMessage, callId: string): void {
    const socket = this.callToSocket.get(callId);
    if (!socket || socket.destroyed) return;
    socket.write(JSON.stringify(message) + DELIMITER, ENCODING);
  }

  /** Sends a message to every connected adapter socket (used for `start_call`). */
  private broadcast(message: VoiceOutboundMessage): void {
    for (const socket of this.sockets) {
      if (socket.destroyed) continue;
      socket.write(JSON.stringify(message) + DELIMITER, ENCODING);
    }
  }
}
