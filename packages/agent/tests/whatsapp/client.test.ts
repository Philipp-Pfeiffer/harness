/**
 * Baileys MIME→Message-Type Mapping Tests.
 *
 * Verifies:
 * - image/* → "image" message type
 * - audio/* → "audio" message type
 * - video/* → "video" message type
 * - other → "document" message type
 * - asSticker=true → "sticker" (overrides MIME)
 * - WhatsApp client mock exposes sendFile
 */

import { describe, it, expect } from "vitest";
import { baileysMessageType, createMockWhatsAppClient } from "../../src/whatsapp/client.js";

describe("Baileys MIME → Message Type Mapping", () => {
  describe("baileysMessageType", () => {
    it("maps image MIME types to 'image'", () => {
      expect(baileysMessageType("image/jpeg", false)).toBe("image");
      expect(baileysMessageType("image/png", false)).toBe("image");
      expect(baileysMessageType("image/webp", false)).toBe("image");
    });

    it("maps audio MIME types to 'audio'", () => {
      expect(baileysMessageType("audio/ogg", false)).toBe("audio");
      expect(baileysMessageType("audio/mpeg", false)).toBe("audio");
      expect(baileysMessageType("audio/mp4", false)).toBe("audio");
    });

    it("maps video MIME types to 'video'", () => {
      expect(baileysMessageType("video/mp4", false)).toBe("video");
      expect(baileysMessageType("video/3gpp", false)).toBe("video");
    });

    it("maps unknown MIME types to 'document'", () => {
      expect(baileysMessageType("application/pdf", false)).toBe("document");
      expect(baileysMessageType("application/zip", false)).toBe("document");
      expect(baileysMessageType("application/octet-stream", false)).toBe("document");
      expect(baileysMessageType("text/plain", false)).toBe("document");
    });

    it("overrides to 'sticker' when asSticker=true", () => {
      expect(baileysMessageType("image/webp", true)).toBe("sticker");
      expect(baileysMessageType("image/jpeg", true)).toBe("sticker");
      expect(baileysMessageType("application/pdf", true)).toBe("sticker");
    });
  });

  describe("createMockWhatsAppClient", () => {
    it("exposes sendFile method", () => {
      const client = createMockWhatsAppClient();
      expect(typeof client.sendFile).toBe("function");
    });

    it("sendFile resolves without error in mock", async () => {
      const client = createMockWhatsAppClient();
      await expect(
        client.sendFile("test@s.whatsapp.net", {
          buffer: Buffer.from("test"),
          mimeType: "image/png",
        }),
      ).resolves.toBeUndefined();
    });
  });
});
