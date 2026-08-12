/**
 * WhatsApp Inbound Processor Tests.
 *
 * Verifies:
 * - Debounce: messages within 1s window are combined into one turn
 * - Steer-always: a message during a running turn is ALWAYS steered via the
 *   mailbox (no abort-and-restart) with the full text intact
 * - Stop-Word: exact "stop"/"stopp" (case-insensitive) during a running turn
 *   aborts the turn via the user abort signal and confirms via outbound;
 *   at idle it is a normal message
 * - Double-message scenario (incident): two fast messages → one consistent
 *   response, no duplicates
 * - 8h inactivity: compaction triggered before turn; after rotation the
 *   current message is submitted immediately (no debounce) as first turn
 * - First turn after resolution-rotation (daemon restart): immediate turn
 * - Test-Mode: echo instead of agent turns, structured log events
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WhatsAppInboundProcessor } from "../../src/whatsapp/inbound.js";
import type { ChannelInboundEvent, InboundImageBlock } from "../../src/daemon/types.js";
import {
  INBOUND_DEBOUNCE_MS,
  SESSION_INACTIVITY_THRESHOLD_MS,
  PRESENCE_COMPOSING_REFRESH_MS,
  ROTATION_GUARD_MS,
} from "../../src/whatsapp/limits.js";

function createEvent(source: string, text: string, extra?: Partial<ChannelInboundEvent>): ChannelInboundEvent {
  return {
    channel: "whatsapp",
    source,
    text,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function createMockCallbacks() {
  let resolveTurn: ((result: { finalResponse: string }) => void) | null = null;
  let resolveResult = { sessionId: "", rotated: false };
  let lastSignal: AbortSignal | undefined;

  return {
    callbacks: {
      submitTurn: vi.fn(async (_sessionId: string, _text: string, _imageBlocks?: InboundImageBlock[], signal?: AbortSignal) => {
        lastSignal = signal;
        return new Promise<{ finalResponse: string }>((resolve) => {
          resolveTurn = resolve;
        });
      }),
      compactSession: vi.fn(async () => {}),
      rotateSessionForInactivity: vi.fn(async (source: string, _oldSessionId: string) => `session-rotated-${source}`),
      resolveSession: vi.fn(async (source: string) => {
        if (!resolveResult.sessionId) resolveResult.sessionId = `session-${source}`;
        return { ...resolveResult };
      }),
      sendOutbound: vi.fn(async (_target: string, _text: string) => {}),
      steer: vi.fn(),
      executeCommand: vi.fn(async (_sessionId: string, _text: string) => {
        return { response: `OK: ${_text}` };
      }),
      setPresence: vi.fn(),
    },
    setResolveResult: (result: { sessionId: string; rotated: boolean }) => {
      resolveResult = result;
    },
    completeTurn: (response: string = "Agent response") => {
      resolveTurn?.({ finalResponse: response });
      resolveTurn = null;
    },
    getSignal: () => lastSignal,
    reset: () => {
      lastSignal = undefined;
    },
  };
}

describe("WhatsApp Inbound Processor", () => {
  let mock: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    mock = createMockCallbacks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Debounce ───

  describe("Debounce", () => {
    it("combines messages within 1s window into one turn", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(200);
      await processor.processInbound(createEvent("491701234567", "World"));

      // Turn should NOT have been submitted yet (within debounce window)
      expect(mock.callbacks.submitTurn).not.toHaveBeenCalled();

      // Advance past debounce window
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.submitTurn.mock.calls[0]![1]).toContain("Hello");
      expect(mock.callbacks.submitTurn.mock.calls[0]![1]).toContain("World");
    });

    it("flushes after debounce window even with single message", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "Single message"));

      expect(mock.callbacks.submitTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.submitTurn.mock.calls[0]![1]).toContain("Single message");
    });
  });

  // ─── Steer-always during running turn ───

  describe("Steer during running turn", () => {
    it("steers a message during a running turn (no restart), text fully intact", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // First message → debounce → turn starts
      await processor.processInbound(createEvent("491701234567", "First message"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);

      // Message during the running turn (even <5s, no tool executed) → steer
      await processor.processInbound(createEvent("491701234567", "Second message"));

      // NO second submitTurn (no abort-and-restart)
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      // Steer with the full, unmodified text
      expect(mock.callbacks.steer).toHaveBeenCalledWith(
        "session-491701234567",
        "Second message",
      );

      // Steer text must arrive in the running turn — the mailbox drains the
      // steer into the context. With annotations, they are appended.
      await processor.processInbound(createEvent("491701234567", "Third message", {
        annotations: ["Voice-Nachricht empfangen."],
      }));
      expect(mock.callbacks.steer).toHaveBeenLastCalledWith(
        "session-491701234567",
        "Third message\nVoice-Nachricht empfangen.",
      );
    });

    it("does not steer once the turn completed", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "First"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);

      // Turn completes → next message starts a debounce (not a steer)
      mock.completeTurn("Response");
      await vi.advanceTimersByTimeAsync(10);
      await processor.processInbound(createEvent("491701234567", "Second"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.steer).not.toHaveBeenCalled();
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(2);
    });

    it("passes a signal to submitTurn so stop-word can abort the running turn", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "First"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      const signal = mock.getSignal();
      expect(signal).toBeDefined();
      expect(signal!.aborted).toBe(false);

      // Stop word → signal aborted with the distinguishable "user" reason
      await processor.processInbound(createEvent("491701234567", "stop"));
      expect(signal!.aborted).toBe(true);
      expect(signal!.reason).toBe("user");
    });
  });

  // ─── Stop-Word ───

  describe("Stop-Word Abort", () => {
    it("aborts a running turn on exact 'stop' and confirms via outbound", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "First"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);

      const signal = mock.getSignal();
      expect(signal!.aborted).toBe(false);

      await processor.processInbound(createEvent("491701234567", "stop"));

      // Hard abort via the user abort signal
      expect(signal!.aborted).toBe(true);
      // NOT steered as a message
      expect(mock.callbacks.steer).not.toHaveBeenCalled();
      // Confirmation sent immediately
      expect(mock.callbacks.sendOutbound).toHaveBeenCalledWith(
        "491701234567",
        "Turn abgebrochen.",
      );
    });

    it("treats 'STOP' and 'Stopp' as stop words (case-insensitive)", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "First"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      const signal = mock.getSignal();
      await processor.processInbound(createEvent("491701234567", "STOP"));
      expect(signal!.aborted).toBe(true);
    });

    it("does not abort on stop-word with additional text", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "First"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      const signal = mock.getSignal();
      await processor.processInbound(createEvent("491701234567", "stop the music"));

      expect(signal!.aborted).toBe(false);
      // Steered as normal message
      expect(mock.callbacks.steer).toHaveBeenCalledWith(
        "session-491701234567",
        "stop the music",
      );
    });

    it("treats 'stop' as a normal message at idle (no running turn)", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "stop"));

      // Debounced like any other message — no abort, no outbound confirmation
      expect(mock.callbacks.sendOutbound).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.submitTurn.mock.calls[0]![1]).toContain("stop");
      expect(mock.callbacks.steer).not.toHaveBeenCalled();
    });
  });

  // ─── Double-message incident scenario ───

  describe("Double-message scenario (incident)", () => {
    it("two fast messages produce one consistent turn, no duplicates", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // Two messages within the debounce window (fast typing)
      await processor.processInbound(createEvent("491701234567", "Schau mal das an"));
      await vi.advanceTimersByTimeAsync(200);
      await processor.processInbound(createEvent("491701234567", "und sag mir was du siehst"));

      // Exactly ONE turn — combined text, no duplicate/restart
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      const submittedText = mock.callbacks.submitTurn.mock.calls[0]![1] as string;
      expect(submittedText).toContain("Schau mal das an");
      expect(submittedText).toContain("und sag mir was du siehst");
      // Each message appears exactly once
      expect(submittedText.split("Schau mal das an").length - 1).toBe(1);

      // A third message right after the turn started (fast model) → steer,
      // NOT a second turn
      await processor.processInbound(createEvent("491701234567", "Ach und noch eins"));
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.steer).toHaveBeenCalledWith(
        "session-491701234567",
        "Ach und noch eins",
      );
    });
  });

  // ─── 8h Inactivity ───

  describe("8h Inactivity Session Rotation", () => {
    it("rotates session when inactive >8h while daemon is running, then submits immediately", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // First message to create the source state
      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledWith(
        "session-491701234567",
        expect.stringContaining("Hello"),
        [],
        expect.any(AbortSignal),
      );

      // Complete the turn
      mock.completeTurn("Response");
      await vi.advanceTimersByTimeAsync(100);

      // Move time forward >8h
      await vi.advanceTimersByTimeAsync(SESSION_INACTIVITY_THRESHOLD_MS + 1000);

      // New message after 8h inactivity
      await processor.processInbound(createEvent("491701234567", "New message after long break"));

      expect(mock.callbacks.rotateSessionForInactivity).toHaveBeenCalledWith(
        "491701234567",
        "session-491701234567",
      );

      // The turn must be submitted IMMEDIATELY (no debounce wait) on the
      // rotated session, containing the original text with provenance prefix
      expect(mock.callbacks.submitTurn).toHaveBeenLastCalledWith(
        "session-rotated-491701234567",
        "[WhatsApp · 491701234567] New message after long break",
        [],
        expect.any(AbortSignal),
      );

      // No debounce timer should have been armed for the rotated message
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(2);
    });

    it("does not rotate session within 8h", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // First message
      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);

      // Complete the turn
      mock.completeTurn("Response");
      await vi.advanceTimersByTimeAsync(100);

      // Only 1 hour later → no compaction
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      await processor.processInbound(createEvent("491701234567", "Short break message"));

      expect(mock.callbacks.rotateSessionForInactivity).not.toHaveBeenCalled();
    });
  });

  // ─── First Turn After Rotation ───

  describe("First Turn After Session Rotation", () => {
    it("resolves a rotated session and submits the message immediately as first turn", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // Simulate daemon restart after >8h: resolveSession reports a rotated session
      mock.setResolveResult({ sessionId: "session-rotated-491701234567", rotated: true });

      await processor.processInbound(createEvent("491701234567", "My task"));

      // Turn submitted immediately — no debounce timer wait
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledWith(
        "session-rotated-491701234567",
        "[WhatsApp · 491701234567] My task",
        [],
        expect.any(AbortSignal),
      );

      // No debounce arm afterwards → exactly one turn even after the window
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
    });

    it("keeps debouncing when session resolve reports no rotation", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "First"));
      await vi.advanceTimersByTimeAsync(200);
      await processor.processInbound(createEvent("491701234567", "Second"));

      // No rotation → turn must NOT be submitted before the debounce window
      expect(mock.callbacks.submitTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.submitTurn.mock.calls[0]![1]).toContain("First");
      expect(mock.callbacks.submitTurn.mock.calls[0]![1]).toContain("Second");
    });

    it("routes slash commands through the command path even after rotation", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      mock.setResolveResult({ sessionId: "session-rotated-491701234567", rotated: true });

      await processor.processInbound(createEvent("491701234567", "/help"));

      // Command path: no agent turn, no debounce
      expect(mock.callbacks.submitTurn).not.toHaveBeenCalled();
      expect(mock.callbacks.executeCommand).toHaveBeenCalledWith(
        "session-rotated-491701234567",
        "/help",
      );
      expect(mock.callbacks.sendOutbound).toHaveBeenCalledWith(
        "491701234567",
        expect.stringContaining("OK"),
      );
    });
  });

  // ─── Session Rotation Race (Incident 11.08.) ───

  describe("Session Rotation Race (incident 11.08.)", () => {
    it("does NOT re-rotate when the first turn after rotation is still running and a second message arrives", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // Establish source state with a normal turn
      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      mock.completeTurn("Response");
      await vi.advanceTimersByTimeAsync(100);

      // Move past the 8h inactivity threshold
      await vi.advanceTimersByTimeAsync(SESSION_INACTIVITY_THRESHOLD_MS + 1000);

      // First message after inactivity → rotation → first turn starts immediately
      await processor.processInbound(createEvent("491701234567", "New task"));
      expect(mock.callbacks.rotateSessionForInactivity).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(2);
      // lastActivityMs is now current — no stale 8h window
      const stateAfterRotation = processor.getSourceState("491701234567")!;
      expect(stateAfterRotation.lastActivityMs).toBeGreaterThan(Date.now() - 5_000);

      // Second message while the first turn is still running (turn not completed).
      // This is the incident: previously the stale lastActivityMs re-fired the
      // 8h check and killed the fresh session mid-turn.
      await vi.advanceTimersByTimeAsync(30_000);
      await processor.processInbound(createEvent("491701234567", "Steer please"));

      // No second rotation
      expect(mock.callbacks.rotateSessionForInactivity).toHaveBeenCalledTimes(1);

      // The message is steered into the session of the RUNNING turn (the rotated one)
      expect(mock.callbacks.steer).toHaveBeenCalledWith(
        "session-rotated-491701234567",
        "Steer please",
      );

      // The turn still completes in the rotated session (not a killed one)
      mock.completeTurn("Done");
      await vi.advanceTimersByTimeAsync(100);
      expect(mock.callbacks.sendOutbound).toHaveBeenCalledWith(
        "491701234567",
        "Done",
      );
    });

    it("skips the 8h-inactivity check within the rotation guard window even with a stale lastActivityMs", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // Establish state with a completed turn so lastActivityMs is fresh
      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      mock.completeTurn("Response");
      await vi.advanceTimersByTimeAsync(100);

      // Simulate a rotation that already happened (e.g. resolved on restart):
      // rotatedAt is fresh, but lastActivityMs is artificially stale (>8h).
      const state = processor.getSourceState("491701234567")!;
      state.rotatedAt = Date.now();
      state.lastActivityMs = Date.now() - SESSION_INACTIVITY_THRESHOLD_MS - 1000;
      state.sessionId = "session-rotated-491701234567";

      await processor.processInbound(createEvent("491701234567", "Message within guard window"));

      // Guard skips the 8h check → no rotation
      expect(mock.callbacks.rotateSessionForInactivity).not.toHaveBeenCalled();
    });

    it("allows the 8h check again after the rotation guard window expires", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // Establish state with a completed turn so lastActivityMs is fresh
      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      mock.completeTurn("Response");
      await vi.advanceTimersByTimeAsync(100);

      // Rotation happened long ago (> guard), lastActivityMs still stale
      const state = processor.getSourceState("491701234567")!;
      state.rotatedAt = Date.now() - ROTATION_GUARD_MS - 1000;
      state.lastActivityMs = Date.now() - SESSION_INACTIVITY_THRESHOLD_MS - 1000;

      await processor.processInbound(createEvent("491701234567", "Message after guard window"));

      expect(mock.callbacks.rotateSessionForInactivity).toHaveBeenCalledTimes(1);
    });

    it("updates lastActivityMs when the rotation happens via resolveSession (daemon-restart path)", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // No existing source state → resolveSession reports a rotated session
      mock.setResolveResult({ sessionId: "session-rotated-491701234567", rotated: true });

      await processor.processInbound(createEvent("491701234567", "My task"));

      // Fresh state was created with a current lastActivityMs
      const state = processor.getSourceState("491701234567")!;
      expect(state.lastActivityMs).toBeGreaterThan(Date.now() - 5_000);
      expect(state.rotatedAt).toBeGreaterThan(0);

      // Guard active: even a wild second inbound (same tick) must not rotate
      await processor.processInbound(createEvent("491701234567", "Follow-up"));
      expect(mock.callbacks.rotateSessionForInactivity).not.toHaveBeenCalled();
      // With steer-always, the follow-up is steered into the running turn's
      // session (the rotated one), NOT restarted as a second turn.
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.steer).toHaveBeenCalledWith(
        "session-rotated-491701234567",
        "Follow-up",
      );
    });

    it("steers into the running turn's session when a rotation happened mid-turn", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // Start a normal turn
      await processor.processInbound(createEvent("491701234567", "First message"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.submitTurn.mock.calls[0]![0]).toBe("session-491701234567");

      // Mid-turn rotation: sessionId points to a fresh session, but the running
      // turn still belongs to the old one (tracked in turnSessionId)
      const state = processor.getSourceState("491701234567")!;
      state.sessionId = "session-fresh-491701234567";

      await processor.processInbound(createEvent("491701234567", "Steer me"));

      // Steer must go to the RUNNING turn's session, not the fresh one
      expect(mock.callbacks.steer).toHaveBeenCalledWith(
        "session-491701234567",
        "Steer me",
      );
    });
  });

  // ─── Provenance Prefix ───

  describe("Provenance Prefix", () => {
    it("prepends sender name prefix when senderName is set", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "Hello", { senderName: "Philipp" }));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      const text = mock.callbacks.submitTurn.mock.calls[0]![1] as string;
      expect(text).toBe("[WhatsApp · Philipp] Hello");
    });

    it("falls back to source when senderName is not set", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      const text = mock.callbacks.submitTurn.mock.calls[0]![1] as string;
      expect(text).toBe("[WhatsApp · 491701234567] Hello");
    });

    it("prefix is preserved through debounce combination", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "Hello", { senderName: "Philipp" }));
      await vi.advanceTimersByTimeAsync(200);
      await processor.processInbound(createEvent("491701234567", "World", { senderName: "Philipp" }));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      const text = mock.callbacks.submitTurn.mock.calls[0]![1] as string;
      expect(text).toBe("[WhatsApp · Philipp] Hello\nWorld");
    });

    it("appends sticker annotations to the turn text", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // Sticker-only event: no text, annotation carries the sticker info.
      // The flush skips empty turns, so this must reach submitTurn.
      await processor.processInbound(createEvent("491701234567", "", {
        media: [{
          filePath: "/tmp/media/sticker.webp",
          mimeType: "image/webp",
          size: 512,
          type: "sticker",
        }],
        annotations: ["[Sticker: pepe — Der Frosch]"],
      }));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      const text = mock.callbacks.submitTurn.mock.calls[0]![1] as string;
      expect(text).toContain("[WhatsApp · 491701234567]");
      expect(text).toContain("[Sticker: pepe — Der Frosch]");
    });

    it("skips sticker-only turns without annotation (no text, no annotations)", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "", {
        media: [{
          filePath: "/tmp/media/sticker.webp",
          mimeType: "image/webp",
          size: 512,
          type: "sticker",
        }],
      }));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);

      expect(mock.callbacks.submitTurn).not.toHaveBeenCalled();
    });
  });

  // ─── Test Mode ───

  describe("Test Mode", () => {
    it("echoes text message instead of running agent turn", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: true,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "Test text message"));

      // Should NOT call submitTurn
      expect(mock.callbacks.submitTurn).not.toHaveBeenCalled();

      // Should send echo
      expect(mock.callbacks.sendOutbound).toHaveBeenCalledWith(
        "491701234567",
        expect.stringContaining("[test] empfangen"),
      );
    });

    it("echoes media info instead of running agent turn", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: true,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "", {
        media: [{
          filePath: "/tmp/media/test.jpg",
          mimeType: "image/jpeg",
          size: 1024,
          type: "image",
        }],
      }));

      expect(mock.callbacks.submitTurn).not.toHaveBeenCalled();
      expect(mock.callbacks.sendOutbound).toHaveBeenCalledWith(
        "491701234567",
        expect.stringContaining("[test] Media gespeichert"),
      );
    });

    it("detects voice message type with ptt flag", async () => {
      const logCalls: string[] = [];
      const processor = new WhatsAppInboundProcessor({
        log: (msg) => logCalls.push(msg),
        testMode: true,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "[Voice] Hello", {
        isVoiceTranscript: true,
        annotations: ["Voice-Nachricht empfangen, Transkription nicht verfügbar."],
      }));

      const logEntry = logCalls.find((l) => l.includes("[test] Inbound"));
      expect(logEntry).toBeDefined();
      expect(logEntry).toContain("type=voice");
    });

    it("detects sticker type", async () => {
      const logCalls: string[] = [];
      const processor = new WhatsAppInboundProcessor({
        log: (msg) => logCalls.push(msg),
        testMode: true,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "", {
        media: [{
          filePath: "/tmp/media/sticker.webp",
          mimeType: "image/webp",
          size: 512,
          type: "sticker",
        }],
      }));

      const logEntry = logCalls.find((l) => l.includes("[test] Inbound"));
      expect(logEntry).toBeDefined();
      expect(logEntry).toContain("type=sticker");
    });

    it("echoes the sticker annotation when present", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: true,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "", {
        media: [{
          filePath: "/tmp/media/sticker.webp",
          mimeType: "image/webp",
          size: 512,
          type: "sticker",
        }],
        annotations: ["[Sticker: pepe — Der Frosch]"],
      }));

      expect(mock.callbacks.sendOutbound).toHaveBeenCalledWith(
        "491701234567",
        "[test] Sticker: [Sticker: pepe — Der Frosch]",
      );
    });
  });

  // ─── Composing Presence ───

  describe("Composing Presence", () => {
    it("starts composing at turn start and sends paused at turn end", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      // composing fired at turn start (target = phone number source)
      expect(mock.callbacks.setPresence).toHaveBeenCalledWith("composing", "491701234567");

      // Complete the turn → paused
      mock.completeTurn("Agent response");
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.setPresence).toHaveBeenLastCalledWith("paused", "491701234567");
      // The final call must be paused — no composing after it
      const calls = mock.callbacks.setPresence.mock.calls;
      expect(calls[calls.length - 1]![0]).toBe("paused");
    });

    it("refreshes composing every 15s while the turn is running", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      const composingCallsBefore = mock.callbacks.setPresence.mock.calls.filter(
        (c) => c[0] === "composing",
      ).length;
      expect(composingCallsBefore).toBe(1);

      // One refresh interval passes → composing sent again
      await vi.advanceTimersByTimeAsync(PRESENCE_COMPOSING_REFRESH_MS);
      expect(
        mock.callbacks.setPresence.mock.calls.filter((c) => c[0] === "composing").length,
      ).toBe(2);

      // A second interval → composing sent again
      await vi.advanceTimersByTimeAsync(PRESENCE_COMPOSING_REFRESH_MS);
      expect(
        mock.callbacks.setPresence.mock.calls.filter((c) => c[0] === "composing").length,
      ).toBe(3);

      // No paused yet — turn still running
      expect(mock.callbacks.setPresence).not.toHaveBeenCalledWith("paused", expect.anything());
    });

    it("stops refreshing after the turn completes", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      // Complete the turn
      mock.completeTurn("Agent response");
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.setPresence).toHaveBeenLastCalledWith("paused", "491701234567");

      // Even after several refresh windows, composing must NOT be sent again
      const callsAfterPaused = mock.callbacks.setPresence.mock.calls.length;
      await vi.advanceTimersByTimeAsync(PRESENCE_COMPOSING_REFRESH_MS * 3);
      expect(mock.callbacks.setPresence.mock.calls.length).toBe(callsAfterPaused);
    });

    it("does not send composing when the turn is empty (no text)", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // Empty turn (media-only, no text) is skipped
      await processor.processInbound(createEvent("491701234567", "", {
        media: [{
          filePath: "/tmp/media/test.jpg",
          mimeType: "image/jpeg",
          size: 1024,
          type: "image",
        }],
      }));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);

      expect(mock.callbacks.setPresence).not.toHaveBeenCalled();
    });
  });

  // ─── Slash Commands ───

  describe("Slash Commands", () => {
    it("intercepts /-prefixed text before normal mode", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "/help"));

      // Should NOT call submitTurn
      expect(mock.callbacks.submitTurn).not.toHaveBeenCalled();
      // Should call executeCommand
      expect(mock.callbacks.executeCommand).toHaveBeenCalledWith(
        expect.any(String),
        "/help",
      );
      // Response should go through sendOutbound
      expect(mock.callbacks.sendOutbound).toHaveBeenCalledWith(
        "491701234567",
        expect.stringContaining("OK"),
      );
    });

    it("intercepts /-prefixed text in test mode (not echo)", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: true,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "/status"));

      // Should NOT echo as test mode
      expect(mock.callbacks.sendOutbound).not.toHaveBeenCalledWith(
        "491701234567",
        expect.stringContaining("[test]"),
      );
      // Should call executeCommand instead
      expect(mock.callbacks.executeCommand).toHaveBeenCalledWith(
        expect.any(String),
        "/status",
      );
    });

    it("intercepts commands during a running turn", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // Start a normal turn first
      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);

      // Now send a slash command while the turn is running
      await processor.processInbound(createEvent("491701234567", "/model"));

      // Should be handled immediately via executeCommand (no debounce, no steering)
      expect(mock.callbacks.steer).not.toHaveBeenCalled();
      expect(mock.callbacks.executeCommand).toHaveBeenCalledWith(
        expect.any(String),
        "/model",
      );
      // Response should go through sendOutbound immediately
      expect(mock.callbacks.sendOutbound).toHaveBeenCalledWith(
        "491701234567",
        expect.stringContaining("OK"),
      );
    });

    it("no provenance prefix on command text", async () => {
      mock.callbacks.executeCommand = vi.fn(async (_sessionId: string, text: string) => {
        // Verify the text passed has NO provenance prefix
        return { response: `text was: ${text}` };
      });

      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "/model gpt-5", { senderName: "Philipp" }));

      expect(mock.callbacks.executeCommand).toHaveBeenCalledWith(
        expect.any(String),
        "/model gpt-5",
      );
    });

    it("non-command messages still go through normal processing", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "Just a normal message"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);

      expect(mock.callbacks.executeCommand).not.toHaveBeenCalled();
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
    });

    it("whitespace-only text starting with / is still intercepted", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "   /help"));

      expect(mock.callbacks.executeCommand).toHaveBeenCalledWith(
        expect.any(String),
        "   /help",
      );
      expect(mock.callbacks.submitTurn).not.toHaveBeenCalled();
    });
  });
});
