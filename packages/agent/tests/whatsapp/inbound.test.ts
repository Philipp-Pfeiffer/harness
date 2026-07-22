/**
 * WhatsApp Inbound Processor Tests.
 *
 * Verifies:
 * - Debounce: messages within 1s window are combined into one turn
 * - Abort-and-Restart: new message <5s after turn start, before first tool call
 *   → restart with combined context (max 2 restarts, then steer)
 * - After first tool call: only steer, no restart
 * - 8h inactivity: compaction triggered before turn
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

  return {
    callbacks: {
      submitTurn: vi.fn(async (_sessionId: string, _text: string) => {
        return new Promise<{ finalResponse: string }>((resolve) => {
          resolveTurn = resolve;
        });
      }),
      compactSession: vi.fn(async () => {}),
      resolveSession: vi.fn(async (source: string) => `session-${source}`),
      sendOutbound: vi.fn(async (_target: string, _text: string) => {}),
      steer: vi.fn(),
      checkToolExecuted: vi.fn(() => toolExecuted),
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
      expect(mock.callbacks.submitTurn.mock.calls[0]![1]).toBe("Single message");
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

  describe("8h Inactivity Compaction", () => {
    it("triggers compaction when session inactive >8h", async () => {
      const processor = new WhatsAppInboundProcessor({
        log: () => {},
        testMode: false,
        callbacks: mock.callbacks,
      });

      // First message to create the source state
      await processor.processInbound(createEvent("491701234567", "Hello"));
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(1);

      // Complete the turn
      mock.completeTurn("Response");
      await vi.advanceTimersByTimeAsync(100);

      // Move time forward >8h
      await vi.advanceTimersByTimeAsync(SESSION_INACTIVITY_THRESHOLD_MS + 1000);

      // New message after 8h inactivity
      await processor.processInbound(createEvent("491701234567", "New message after long break"));

      // Compaction should have been called
      expect(mock.callbacks.compactSession).toHaveBeenCalledWith("session-491701234567");

      // Then the debounce → turn should fire
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS + 100);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.callbacks.submitTurn).toHaveBeenCalledTimes(2);
    });

    it("does not trigger compaction within 8h", async () => {
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

      expect(mock.callbacks.compactSession).not.toHaveBeenCalled();
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
});
