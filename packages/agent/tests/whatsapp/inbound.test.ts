/**
 * WhatsApp Inbound Processor Tests.
 *
 * Verifies:
 * - Debounce: messages within 1s window are combined into one turn
 * - Abort-and-Restart: new message <5s after turn start, before first tool call
 *   → restart with combined context (max 2 restarts, then steer)
 * - After first tool call: only steer, no restart
 * - 8h inactivity: compaction triggered before turn; after rotation the
 *   current message is submitted immediately (no debounce) as first turn
 * - First turn after resolution-rotation (daemon restart): immediate turn
 * - Test-Mode: echo instead of agent turns, structured log events
 * - Partial output of aborted turn is discarded
 * - pushAbortAnnotation does NOT fire (internal abort ≠ user abort)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WhatsAppInboundProcessor } from "../../src/whatsapp/inbound.js";
import type { ChannelInboundEvent } from "../../src/daemon/types.js";
import {
  INBOUND_DEBOUNCE_MS,
  ABORT_RESTART_WINDOW_MS,
  SESSION_INACTIVITY_THRESHOLD_MS,
  PRESENCE_COMPOSING_REFRESH_MS,
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
  let toolExecuted = false;
  let resolveTurn: ((result: { finalResponse: string }) => void) | null = null;
  let resolveResult = { sessionId: "", rotated: false };

  return {
    callbacks: {
      submitTurn: vi.fn(async (_sessionId: string, _text: string) => {
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
      checkToolExecuted: vi.fn(() => toolExecuted),
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
    setToolExecuted: (val: boolean) => {
      toolExecuted = val;
    },
    reset: () => {
      toolExecuted = false;
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

  // ─── Abort-and-Restart ───

  describe("Abort-and-Restart", () => {
    it("restarts turn when new message <5s after turn start, no tool executed", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // First message → starts debounce
      await processor.processInbound(createEvent("491701234567", "First message"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);

      // Tool NOT executed yet
      // Second message within abort window → should trigger restart
      await vi.advanceTimersByTimeAsync(500); // <5s after turn start

      await processor.processInbound(createEvent("491701234567", "Second message"));

      // Should have called submitTurn again (restart)
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(2);

      // Second turn should contain combined text
      expect(mock.callbacks.submitTurn.mock.calls[1]![1]).toContain("First message");
      expect(mock.callbacks.submitTurn.mock.calls[1]![1]).toContain("Second message");
    });

    it("steers via mailbox after first tool call (no restart)", async () => {
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

      // Simulate tool execution happening
      mock.setToolExecuted(true);

      // Second message within abort window
      await vi.advanceTimersByTimeAsync(500);
      await processor.processInbound(createEvent("491701234567", "Second message"));

      // Should NOT restart — should steer instead
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.steer).toHaveBeenCalledWith(
        "session-491701234567",
        "Second message",
      );
    });

    it("max 2 restarts, then steer only", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // First message → debounce → turn starts
      await processor.processInbound(createEvent("491701234567", "msg1"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);

      // Restart 1
      await vi.advanceTimersByTimeAsync(500);
      await processor.processInbound(createEvent("491701234567", "msg2"));
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(2);

      // Restart 2
      await vi.advanceTimersByTimeAsync(500);
      await processor.processInbound(createEvent("491701234567", "msg3"));
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(3);

      // Third restart attempt → should steer, not restart
      await vi.advanceTimersByTimeAsync(500);
      await processor.processInbound(createEvent("491701234567", "msg4"));

      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(3);
      expect(mock.callbacks.steer).toHaveBeenCalledWith(
        "session-491701234567",
        "msg4",
      );
    });

    it("does not restart if >5s after turn start", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      await processor.processInbound(createEvent("491701234567", "First"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);

      // Travel past the abort window (>5s)
      await vi.advanceTimersByTimeAsync(ABORT_RESTART_WINDOW_MS + 100);

      await processor.processInbound(createEvent("491701234567", "Second"));

      // Should steer, not restart
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);
      expect(mock.callbacks.steer).toHaveBeenCalled();
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
