/**
 * Outbound Pipeline Tests.
 *
 * Verifies:
 * - Attachments from RenderedMessage are sent (not just logged)
 * - Text + Attachments sent in correct order with delay
 * - Text-Fallback when attachment send fails
 * - supportsMimeType capability check
 */

import { describe, it, expect, vi } from "vitest";
import { sendRenderedMessages, isFileSupported } from "../../src/whatsapp/outbound.js";
import type { RenderedMessage } from "../../src/output/index.js";

function createMockSender() {
  const calls: { jid: string; text?: string; files?: Array<{ buffer?: Buffer; mimeType: string; caption?: string }> }[] = [];
  return {
    calls,
    fn: vi.fn(async (jid: string, payload: { text?: string; files?: Array<{ buffer?: Buffer; mimeType: string }> }) => {
      calls.push({ jid, text: payload.text, files: payload.files });
    }),
  };
}

describe("Outbound Pipeline", () => {
  describe("sendRenderedMessages", () => {
    it("sends text messages sequentially", async () => {
      const sender = createMockSender();
      const messages: RenderedMessage[] = [
        { text: "First", attachments: [] },
        { text: "Second", attachments: [] },
      ];

      await sendRenderedMessages("test@s.whatsapp.net", messages, sender.fn);

      expect(sender.calls.length).toBe(2);
      expect(sender.calls[0]!.text).toBe("First");
      expect(sender.calls[1]!.text).toBe("Second");
    });

    it("sends attachments as files (not just logging)", async () => {
      const sender = createMockSender();
      const pngData = Buffer.from("fake-png-data");
      const messages: RenderedMessage[] = [
        { text: "Here is the table:", attachments: [{ type: "image", mimeType: "image/png", data: pngData, filename: "table-0.png" }] },
      ];

      await sendRenderedMessages("test@s.whatsapp.net", messages, sender.fn);

      // First call: text
      expect(sender.calls[0]!.text).toBe("Here is the table:");
      // Second call: file with buffer
      expect(sender.calls[1]!.files).toBeDefined();
      expect(sender.calls[1]!.files![0]!.buffer).toBe(pngData);
      expect(sender.calls[1]!.files![0]!.mimeType).toBe("image/png");
    });

    it("sends text before attachments (correct order)", async () => {
      const sender = createMockSender();
      const messages: RenderedMessage[] = [
        { text: "Table below:", attachments: [{ type: "image", mimeType: "image/png", data: Buffer.from("png"), filename: "t.png" }] },
        { text: "After table", attachments: [] },
      ];

      await sendRenderedMessages("test@s.whatsapp.net", messages, sender.fn);

      expect(sender.calls.length).toBe(3);
      expect(sender.calls[0]!.text).toBe("Table below:");
      expect(sender.calls[1]!.files).toBeDefined();
      expect(sender.calls[2]!.text).toBe("After table");
    });

    it("Text-Fallback when attachment send fails", async () => {
      const sender = createMockSender();
      // Make file sends fail
      sender.fn.mockImplementation(async (jid: string, payload: { text?: string; files?: unknown[] }) => {
        if (payload.files) {
          throw new Error("WhatsApp send failed");
        }
        sender.calls.push({ jid, text: payload.text });
      });

      const messages: RenderedMessage[] = [
        { text: "Data:", attachments: [{ type: "image", mimeType: "image/png", data: Buffer.from("png"), filename: "table.png" }] },
      ];

      await sendRenderedMessages("test@s.whatsapp.net", messages, sender.fn, () => {});

      // Text sent first
      expect(sender.calls[0]!.text).toBe("Data:");
      // Fallback text sent after failure
      expect(sender.calls[1]!.text).toContain("konnte nicht gesendet werden");
    });
  });

  describe("isFileSupported", () => {
    it("returns true for supported MIME types on whatsapp", () => {
      expect(isFileSupported("whatsapp", "image/jpeg")).toBe(true);
      expect(isFileSupported("whatsapp", "audio/ogg")).toBe(true);
      expect(isFileSupported("whatsapp", "video/mp4")).toBe(true);
      expect(isFileSupported("whatsapp", "application/pdf")).toBe(true);
    });

    it("returns true for text/* on whatsapp", () => {
      expect(isFileSupported("whatsapp", "text/plain")).toBe(true);
    });

    it("returns false for unsupported MIME types on whatsapp", () => {
      expect(isFileSupported("whatsapp", "application/x-shockwave-flash")).toBe(false);
    });
  });
});
