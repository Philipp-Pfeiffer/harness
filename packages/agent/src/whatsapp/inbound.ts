/**
 * WhatsApp Inbound Processor.
 *
 * Handles:
 * - Debounce: Accumulate messages within INBOUND_DEBOUNCE_MS into one turn.
 * - Steer: A user message arriving while a turn is running is ALWAYS queued
 *   into the mailbox (steer). No abort-and-restart: restarting the turn after
 *   a fast model already sent its first response produced duplicate answers.
 * - Stop-Word: An exact "stop"/"stopp" (case-insensitive) message while a
 *   turn is running aborts the turn hard via the user abort signal.
 * - 8h-Inactivity: rotate to a fresh session and notify before the turn when
 *   the user returns after SESSION_INACTIVITY_THRESHOLD_MS.
 * - Test Mode: Echo instead of agent turns, structured logging of all events.
 */

import type { ChannelInboundEvent, InboundImageBlock } from "../daemon/types.js";
import {
  INBOUND_DEBOUNCE_MS,
  SESSION_INACTIVITY_THRESHOLD_MS,
  PRESENCE_COMPOSING_REFRESH_MS,
  ROTATION_GUARD_MS,
} from "./limits.js";

/** Stop words that hard-abort a running turn (whole message, case-insensitive). */
const STOP_WORDS = new Set(["stop", "stopp"]);

type LogFn = (msg: string, level?: "info" | "warn" | "error") => void;

/** Per-source state tracked by the processor. */
interface SourceState {
  /** Last activity timestamp (ms epoch). */
  lastActivityMs: number;
  /** Abort controller of the running turn (for user stop-word abort). */
  currentAbort: AbortController | null;
  /** Debounce timer. */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Accumulated messages during debounce window. */
  pendingEvents: ChannelInboundEvent[];
  /** Whether a turn is currently running. */
  turnRunning: boolean;
  /** Resolved session ID for this source. */
  sessionId: string;
  /** Session the currently running turn belongs to (set at turn start). */
  turnSessionId: string | null;
  /**
   * Timestamp of the last session rotation (0 = none). While within
   * ROTATION_GUARD_MS, the 8h-inactivity check is skipped to protect a
   * freshly rotated session from a stale lastActivityMs re-trigger.
   */
  rotatedAt: number;
  /** Composing-indicator refresh timer for the currently running turn. */
  presenceTimer: ReturnType<typeof setInterval> | null;
}

/** Callbacks provided by the daemon. */
export interface InboundProcessorCallbacks {
  /** Submit a turn to the agent loop. The signal is wired to agent.run so a
   *  stop-word message can abort the running turn. Returns the final response. */
  submitTurn: (sessionId: string, text: string, imageBlocks?: InboundImageBlock[], signal?: AbortSignal) => Promise<{ finalResponse: string }>;
  /** Trigger session compaction before the turn. */
  compactSession: (sessionId: string) => Promise<void>;
  /** End inactive session and start a fresh one after the 8h boundary. */
  rotateSessionForInactivity: (source: string, sessionId: string) => Promise<string>;
  /** Resolve or create a session for a source identifier. Returns whether the session was rotated (>8h). */
  resolveSession: (source: string) => Promise<{ sessionId: string; rotated: boolean }>;
  /** Send an outbound message (rendered text) to a target JID. */
  sendOutbound: (target: string, text: string) => Promise<void>;
  /** Steer a running turn by pushing to the mailbox. */
  steer: (sessionId: string, text: string) => void;
  /** Execute a slash command and return {response, newSessionId?}. */
  executeCommand: (sessionId: string, text: string) => Promise<{ response: string; newSessionId?: string }>;
  /** Sends a WhatsApp presence update: "composing"/"paused" for a chat. */
  setPresence: (type: "composing" | "paused", jid?: string) => void;
}

/** Constructor options. */
export interface WhatsAppInboundProcessorOptions {
  log: LogFn;
  testMode: boolean;
  callbacks: InboundProcessorCallbacks;
}

/**
 * Processes inbound WhatsApp messages with debounce, steer-while-running,
 * stop-word abort, 8h-compaction, and test-mode support.
 */
export class WhatsAppInboundProcessor {
  private readonly log: LogFn;
  private readonly testMode: boolean;
  private readonly callbacks: InboundProcessorCallbacks;
  private readonly sourceStates = new Map<string, SourceState>();

  constructor(opts: WhatsAppInboundProcessorOptions) {
    this.log = opts.log;
    this.testMode = opts.testMode;
    this.callbacks = opts.callbacks;
  }

  /**
   * Main entry point. Called for each inbound event from the WhatsApp client.
   */
  async processInbound(event: ChannelInboundEvent): Promise<void> {
    // Slash command interception: must happen BEFORE test mode and normal mode.
    // Commands never go through the agent loop, debounce, or provenance prefix.
    if (event.text.trimStart().startsWith("/")) {
      await this.handleSlashCommand(event);
      return;
    }

    // Test mode: structured logging + echo, no agent turns
    if (this.testMode) {
      await this.handleTestMode(event);
      return;
    }

    // Normal mode: debounce + process
    await this.handleNormalMode(event);
  }

  /** Returns whether the event's whole text (case-insensitive) is a stop word. */
  private isStopWord(text: string): boolean {
    return STOP_WORDS.has(text.trim().toLowerCase());
  }

  // ─── Slash Commands ───

  private async handleSlashCommand(event: ChannelInboundEvent): Promise<void> {
    try {
      // Resolve session (same logic as handleNormalMode would use)
      let state = this.sourceStates.get(event.source);
      const resolved = state?.sessionId
        ? { sessionId: state.sessionId, rotated: false }
        : await this.callbacks.resolveSession(event.source);
      const sessionId = resolved.sessionId;
      const result = await this.callbacks.executeCommand(sessionId, event.text);
      await this.callbacks.sendOutbound(event.source, result.response);

      // Update source state if the session changed
      if (result.newSessionId && result.newSessionId !== sessionId) {
        if (!state) {
          state = this.sourceStates.get(event.source);
        }
        if (state) {
          state.sessionId = result.newSessionId;
        }
      }
    } catch (err) {
      this.log(`Slash command failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      try {
        await this.callbacks.sendOutbound(event.source, "Command failed. Try /help for available commands.");
      } catch {
        // Can't send error response
      }
    }
  }

  // ─── Test Mode ───

  private async handleTestMode(event: ChannelInboundEvent): Promise<void> {
    const phone = event.source;
    const msgType = this.detectMessageType(event);
    const textLen = event.text.length;
    const hasPtt = event.annotations?.some((a) => a.includes("Voice-Nachricht")) ?? false;
    const hasSticker = msgType === "sticker";
    const mediaInfo = event.media?.map((m) => `${m.type}:${m.size}`) ?? [];

    this.log(
      `[test] Inbound: from=${phone} type=${msgType} text=${textLen}chars ` +
      `ptt=${hasPtt} sticker=${hasSticker} media=[${mediaInfo.join(", ")}]`,
      "info",
    );

    // Echo to whitelisted senders only
    // Voice transcripts: show the transcript text
    // Stickers: echo sticker file name
    // Other media: echo file name
    const echoText = msgType === "sticker"
      ? `[test] Sticker gespeichert: ${event.media?.map((m) => m.filePath.split("/").pop()).join(", ") ?? "kein Download"}`
      : event.isVoiceTranscript && event.text
      ? `[test] Voice transkribiert: ${event.text}`
      : event.media && event.media.length > 0
      ? `[test] Media gespeichert: ${event.media.map((m) => m.filePath.split("/").pop()).join(", ")}`
      : `[test] empfangen: ${msgType}, ${textLen} Zeichen`;

    try {
      await this.callbacks.sendOutbound(phone, echoText);
    } catch (err) {
      this.log(`[test] Echo failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  }

  // ─── Normal Mode ───

  private async handleNormalMode(event: ChannelInboundEvent): Promise<void> {
    let state = this.sourceStates.get(event.source);
    let rotated = false;

    if (!state) {
      const resolved = await this.callbacks.resolveSession(event.source);
      const now = Date.now();
      state = {
        lastActivityMs: now,
        currentAbort: null,
        debounceTimer: null,
        pendingEvents: [],
        turnRunning: false,
        sessionId: resolved.sessionId,
        turnSessionId: null,
        rotatedAt: resolved.rotated ? now : 0,
        presenceTimer: null,
      };
      this.sourceStates.set(event.source, state);
      rotated = resolved.rotated;
    }

    // Check 8h inactivity — rotate to a fresh session before the turn.
    // Guard: skip while within ROTATION_GUARD_MS of a previous rotation so a
    // stale lastActivityMs (incident 11.08.: lastActivityMs is only updated
    // in handleTurnComplete) cannot kill a freshly rotated session mid-turn.
    const now = Date.now();
    const inactiveMs = now - state.lastActivityMs;
    const withinRotationGuard = state.rotatedAt > 0 && now - state.rotatedAt < ROTATION_GUARD_MS;
    if (state.lastActivityMs > 0 && !withinRotationGuard && inactiveMs > SESSION_INACTIVITY_THRESHOLD_MS) {
      this.log(
        `Session ${state.sessionId} inactive for ${Math.round(inactiveMs / 3_600_000)}h — rotating session`,
        "info",
      );
      try {
        state.sessionId = await this.callbacks.rotateSessionForInactivity(event.source, state.sessionId);
        // A rotated session has no prior context — submit the current message
        // immediately as the first turn instead of debouncing it.
        rotated = true;
        // Fresh session → refresh activity timestamp and arm the rotation
        // guard so the 8h check cannot re-fire from the old lastActivityMs.
        state.lastActivityMs = Date.now();
        state.rotatedAt = Date.now();
      } catch (err) {
        this.log(`Session rotation failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }

    // After a session rotation (8h inactivity): skip debounce and submit the
    // current message immediately as the first turn of the fresh session.
    // Guarded by !turnRunning so a message arriving mid-turn keeps using the
    // steer / stop path.
    if (rotated && !state.turnRunning) {
      state.pendingEvents.push(event);
      // Fire-and-forget like the debounce path — a turn must not block the
      // inbound pipeline; the reset notice was already sent by the rotation.
      this.flushDebounced(event.source).catch((err) => {
        this.log(`Immediate turn after rotation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      });
      return;
    }

    // If a turn is running: hard-abort on stop word, otherwise steer.
    // A user message during a running turn NEVER restarts the turn — it is
    // always queued into the mailbox so the agent processes it in-context.
    if (state.turnRunning) {
      if (this.isStopWord(event.text)) {
        this.log(`Stop-word received for ${event.source} — aborting running turn`, "info");
        // Abort with the distinguishable "user" reason — the agent loop
        // surfaces it as `reason: "user"` (not the generic "signal").
        state.currentAbort?.abort("user");
        state.currentAbort = null;
        // Confirm the abort immediately; the agent loop stops on its next
        // abort checkpoint (running tool calls finish first).
        this.callbacks.sendOutbound(event.source, "Turn abgebrochen.").catch((err) => {
          this.log(`Abort confirmation send failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        });
      } else {
        // Route into the session of the RUNNING turn (turnSessionId): if the
        // 8h rotation fired during this turn (stale lastActivityMs), the
        // fresh session has no turn running yet — steering into it would only
        // surface in the wrong context minutes later.
        const steerSessionId = state.turnSessionId ?? state.sessionId;
        this.log(`Steering turn for ${event.source} into session ${steerSessionId}`, "info");
        const steerText = event.annotations?.length
          ? `${event.text}\n${event.annotations.join("\n")}`
          : event.text;
        this.callbacks.steer(steerSessionId, steerText);
      }
      return;
    }

    // No turn running: debounce the message
    state.pendingEvents.push(event);

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    state.debounceTimer = setTimeout(() => {
      this.flushDebounced(event.source).catch((err) => {
        this.log(`Debounce flush failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      });
    }, INBOUND_DEBOUNCE_MS);
  }

  private async flushDebounced(source: string): Promise<void> {
    const state = this.sourceStates.get(source);
    if (!state || state.pendingEvents.length === 0) return;

    const events = state.pendingEvents.splice(0);
    state.debounceTimer = null;

    // Combine all debounced messages
    const combinedText = events.map((e) => e.text).filter(Boolean).join("\n");
    const combinedImageBlocks = events.flatMap((e) => e.imageBlocks ?? []);
    const combinedAnnotations = events.flatMap((e) => e.annotations ?? []);

    const fullText = combinedAnnotations.length > 0
      ? `${combinedText}\n\n${combinedAnnotations.join("\n")}`
      : combinedText;

    // Skip empty turns (e.g., sticker-only with no text)
    if (!fullText) {
      this.log(`Skipping empty turn for ${source} (media-only, no text)`, "info");
      return;
    }

    // Prepend provenance prefix so the model knows this is an external channel message
    const senderName = events[0]?.senderName ?? source;
    const provenancePrefix = `[WhatsApp · ${senderName}] `;
    const prefixedText = provenancePrefix + fullText;

    // Start the turn
    state.turnRunning = true;
    state.turnSessionId = state.sessionId;
    const abortController = new AbortController();
    state.currentAbort = abortController;

    this.startComposingPresence(source);

    try {
      const result = await this.callbacks.submitTurn(
        state.sessionId,
        prefixedText,
        combinedImageBlocks,
        abortController.signal,
      );
      this.handleTurnComplete(source, state, result.finalResponse);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`Turn failed: ${errMsg}`, "error");
      // Send error feedback to the chat
      try {
        await this.callbacks.sendOutbound(source, `[Fehler] Agent-Turn fehlgeschlagen: ${errMsg}`);
      } catch {
        // Can't even send error — nothing more to do
      }
      this.handleTurnComplete(source, state, null);
    }
  }

  private handleTurnComplete(
    source: string,
    state: SourceState,
    response: string | null,
  ): void {
    state.turnRunning = false;
    state.currentAbort = null;
    state.lastActivityMs = Date.now();
    state.turnSessionId = null;
    this.stopComposingPresence(source, state);

    // Send the response back via the channel
    if (response) {
      this.callbacks.sendOutbound(source, response).catch((err) => {
        this.log(`Outbound failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      });
    }
  }

  /**
   * Starts the composing indicator for a turn on `source` and arms a refresh
   * interval (WhatsApp's composing state expires after ~20-30s). Sending is
   * fire-and-forget — presence failures must never fail a turn.
   */
  private startComposingPresence(source: string): void {
    const state = this.sourceStates.get(source);
    if (!state) return;
    this.callbacks.setPresence("composing", source);
    state.presenceTimer = setInterval(() => {
      this.callbacks.setPresence("composing", source);
    }, PRESENCE_COMPOSING_REFRESH_MS);
  }

  /**
   * Stops the composing refresh interval and clears the indicator ("paused").
   * Called when the turn completes (response sent) or fails.
   */
  private stopComposingPresence(source: string, state: SourceState): void {
    if (state.presenceTimer) {
      clearInterval(state.presenceTimer);
      state.presenceTimer = null;
    }
    this.callbacks.setPresence("paused", source);
  }

  /** Detects message type from the event for test-mode logging. */
  private detectMessageType(event: ChannelInboundEvent): string {
    if (event.isVoiceTranscript) return "voice";
    if (event.media && event.media.length > 0) {
      const types = event.media.map((m) => m.type);
      if (types.includes("sticker")) return "sticker";
      if (types.includes("image")) return "image";
      if (types.includes("audio")) return "audio";
      if (types.includes("video")) return "video";
      if (types.includes("document")) return "document";
    }
    return "text";
  }

  /** Gets the source state for testing. */
  getSourceState(source: string): SourceState | undefined {
    return this.sourceStates.get(source);
  }
}
