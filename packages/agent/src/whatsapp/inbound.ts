/**
 * WhatsApp Inbound Processor.
 *
 * Handles:
 * - Debounce: Accumulate messages within INBOUND_DEBOUNCE_MS into one turn.
 * - Abort-and-Restart: If new message arrives < ABORT_RESTART_WINDOW_MS after
 *   turn start and no tool has executed, abort and restart with expanded context.
 *   Max MAX_RESTARTS_PER_TURN, then steer-only via mailbox.
 * - 8h-Inactivity Compaction: Trigger compaction before the turn when session
 *   has been inactive > SESSION_INACTIVITY_THRESHOLD_MS.
 * - Test Mode: Echo instead of agent turns, structured logging of all events.
 */

import type { ChannelInboundEvent, InboundImageBlock } from "../daemon/types.js";
import {
  INBOUND_DEBOUNCE_MS,
  ABORT_RESTART_WINDOW_MS,
  MAX_RESTARTS_PER_TURN,
  SESSION_INACTIVITY_THRESHOLD_MS,
} from "./limits.js";

type LogFn = (msg: string, level?: "info" | "warn" | "error") => void;

/** Per-source state tracked by the processor. */
interface SourceState {
  /** Last activity timestamp (ms epoch). */
  lastActivityMs: number;
  /** Current turn's abort controller (for internal restart). */
  currentAbort: AbortController | null;
  /** Current turn's start timestamp (ms epoch). */
  turnStartMs: number;
  /** Whether a tool has executed in the current turn. */
  hasToolExecuted: boolean;
  /** Restart count for the current turn. */
  restartCount: number;
  /** Debounce timer. */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Accumulated messages during debounce window. */
  pendingEvents: ChannelInboundEvent[];
  /** Whether a turn is currently running. */
  turnRunning: boolean;
  /** Resolved session ID for this source. */
  sessionId: string;
  /** Text of the currently running turn (for restart context combination). */
  currentTurnText: string;
  /** Image blocks of the currently running turn (for restart). */
  currentTurnImageBlocks: InboundImageBlock[];
  /** Annotations of the currently running turn (for restart). */
  currentTurnAnnotations: string[];
}

/** Callbacks provided by the daemon. */
export interface InboundProcessorCallbacks {
  /** Submit a turn to the agent loop. Returns the final response text. */
  submitTurn: (sessionId: string, text: string, imageBlocks?: InboundImageBlock[]) => Promise<{ finalResponse: string; internalAbortSignal?: AbortSignal }>;
  /** Trigger session compaction before the turn. */
  compactSession: (sessionId: string) => Promise<void>;
  /** Resolve or create a session for a source identifier. */
  resolveSession: (source: string) => Promise<string>;
  /** Send an outbound message (rendered text) to a target JID. */
  sendOutbound: (target: string, text: string) => Promise<void>;
  /** Steer a running turn by pushing to the mailbox. */
  steer: (sessionId: string, text: string) => void;
  /** Check whether a tool has executed in the current turn. */
  checkToolExecuted: (sessionId: string) => boolean;
}

/** Constructor options. */
export interface WhatsAppInboundProcessorOptions {
  log: LogFn;
  testMode: boolean;
  callbacks: InboundProcessorCallbacks;
}

/**
 * Processes inbound WhatsApp messages with debounce, abort-and-restart,
 * 8h-compaction, and test-mode support.
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
    // Test mode: structured logging + echo, no agent turns
    if (this.testMode) {
      await this.handleTestMode(event);
      return;
    }

    // Normal mode: debounce + process
    await this.handleNormalMode(event);
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
    const echoText = event.media && event.media.length > 0
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

    if (!state) {
      const sessionId = await this.callbacks.resolveSession(event.source);
      state = {
        lastActivityMs: Date.now(),
        currentAbort: null,
        turnStartMs: 0,
        hasToolExecuted: false,
        restartCount: 0,
        debounceTimer: null,
        pendingEvents: [],
        turnRunning: false,
        sessionId,
        currentTurnText: "",
        currentTurnImageBlocks: [],
        currentTurnAnnotations: [],
      };
      this.sourceStates.set(event.source, state);
    }

    // Check 8h inactivity — trigger compaction before the turn
    const inactiveMs = Date.now() - state.lastActivityMs;
    if (state.lastActivityMs > 0 && inactiveMs > SESSION_INACTIVITY_THRESHOLD_MS) {
      this.log(
        `Session ${state.sessionId} inactive for ${Math.round(inactiveMs / 3_600_000)}h — triggering compaction`,
        "info",
      );
      try {
        await this.callbacks.compactSession(state.sessionId);
      } catch (err) {
        this.log(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
      }
      // TODO: Hook point for memory distillation of the expired session.
      // Pipeline-Anbindung ist nicht Teil dieses Runs — nur der Aufruf-Punkt.
    }

    // If a turn is running, check abort-and-restart conditions
    if (state.turnRunning) {
      const timeSinceTurnStart = Date.now() - state.turnStartMs;
      const toolExecuted = this.callbacks.checkToolExecuted(state.sessionId);

      if (!toolExecuted && timeSinceTurnStart < ABORT_RESTART_WINDOW_MS && state.restartCount < MAX_RESTARTS_PER_TURN) {
        // Abort-and-restart
        state.restartCount++;
        this.log(
          `Abort-and-restart for ${event.source} (restart ${state.restartCount}/${MAX_RESTARTS_PER_TURN})`,
          "info",
        );

        // Abort the current turn via internal abort signal
        if (state.currentAbort) {
          state.currentAbort.abort();
          state.currentAbort = null;
        }

        // Combine the running turn's text with the new message
        state.pendingEvents.push(event);
        const allTexts = [state.currentTurnText, ...state.pendingEvents.map((e) => e.text)];
        const combinedText = allTexts.filter(Boolean).join("\n");
        const combinedImageBlocks = [
          ...state.currentTurnImageBlocks,
          ...state.pendingEvents.flatMap((e) => e.imageBlocks ?? []),
        ];
        const combinedAnnotations = [
          ...state.currentTurnAnnotations,
          ...state.pendingEvents.flatMap((e) => e.annotations ?? []),
        ];

        const fullText = combinedAnnotations.length > 0
          ? `${combinedText}\n\n${combinedAnnotations.join("\n")}`
          : combinedText;

        // Restart the turn
        state.turnStartMs = Date.now();
        state.hasToolExecuted = false;
        state.currentTurnText = fullText;
        state.currentTurnImageBlocks = combinedImageBlocks;
        state.currentTurnAnnotations = combinedAnnotations;
        state.pendingEvents = [];
        const abortController = new AbortController();
        state.currentAbort = abortController;

        this.callbacks.submitTurn(state.sessionId, fullText, combinedImageBlocks)
          .then((result) => {
            this.handleTurnComplete(event.source, state!, result.finalResponse);
          })
          .catch((err) => {
            this.log(`Turn failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            this.handleTurnComplete(event.source, state!, null);
          });
        return;
      } else {
        // After first tool call or max restarts: steer via mailbox
        this.log(
          `Steering turn for ${event.source} (toolExecuted=${toolExecuted}, restarts=${state.restartCount})`,
          "info",
        );
        const steerText = event.annotations?.length
          ? `${event.text}\n${event.annotations.join("\n")}`
          : event.text;
        this.callbacks.steer(state.sessionId, steerText);
        return;
      }
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

    // Start the turn
    state.turnRunning = true;
    state.turnStartMs = Date.now();
    state.hasToolExecuted = false;
    state.restartCount = 0;
    state.currentTurnText = fullText;
    state.currentTurnImageBlocks = combinedImageBlocks;
    state.currentTurnAnnotations = combinedAnnotations;
    const abortController = new AbortController();
    state.currentAbort = abortController;

    try {
      const result = await this.callbacks.submitTurn(
        state.sessionId,
        fullText,
        combinedImageBlocks,
      );
      this.handleTurnComplete(source, state, result.finalResponse);
    } catch (err) {
      this.log(`Turn failed: ${err instanceof Error ? err.message : String(err)}`, "error");
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
    state.hasToolExecuted = false;
    state.restartCount = 0;
    state.lastActivityMs = Date.now();
    state.currentTurnText = "";
    state.currentTurnImageBlocks = [];
    state.currentTurnAnnotations = [];

    // Send the response back via the channel
    if (response) {
      this.callbacks.sendOutbound(source, response).catch((err) => {
        this.log(`Outbound failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      });
    }
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
