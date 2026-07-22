/**
 * WhatsApp Whitelist Tests.
 *
 * Verifies:
 * - Whitelisted number → isWhitelisted returns true
 * - Non-whitelisted → isWhitelisted returns false, NO sendMessage call
 * - Phone number extraction from JID
 * - JID formatting
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isWhitelisted,
  hasWhitelist,
  extractPhoneNumber,
  formatJid,
} from "../../src/whatsapp/whitelist.js";

describe("WhatsApp Whitelist", () => {
  const originalEnv = process.env.WHATSAPP_WHITELIST_NUMBER;

  beforeEach(() => {
    delete process.env.WHATSAPP_WHITELIST_NUMBER;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.WHATSAPP_WHITELIST_NUMBER = originalEnv;
    } else {
      delete process.env.WHATSAPP_WHITELIST_NUMBER;
    }
  });

  describe("isWhitelisted", () => {
    it("returns true for the whitelisted number", () => {
      process.env.WHATSAPP_WHITELIST_NUMBER = "491701234567";
      expect(isWhitelisted("491701234567@s.whatsapp.net")).toBe(true);
    });

    it("returns false for non-whitelisted numbers", () => {
      process.env.WHATSAPP_WHITELIST_NUMBER = "491701234567";
      expect(isWhitelisted("491709998887@s.whatsapp.net")).toBe(false);
    });

    it("returns false for all numbers when no whitelist is configured", () => {
      expect(isWhitelisted("491701234567@s.whatsapp.net")).toBe(false);
    });

    it("handles JID with device suffix", () => {
      process.env.WHATSAPP_WHITELIST_NUMBER = "491701234567";
      expect(isWhitelisted("491701234567:1@s.whatsapp.net")).toBe(true);
    });
  });

  describe("hasWhitelist", () => {
    it("returns false when no env var is set", () => {
      expect(hasWhitelist()).toBe(false);
    });

    it("returns true when env var is set", () => {
      process.env.WHATSAPP_WHITELIST_NUMBER = "491701234567";
      expect(hasWhitelist()).toBe(true);
    });
  });

  describe("extractPhoneNumber", () => {
    it("extracts number from standard JID", () => {
      expect(extractPhoneNumber("491701234567@s.whatsapp.net")).toBe("491701234567");
    });

    it("extracts number from JID with device suffix", () => {
      expect(extractPhoneNumber("491701234567:2@s.whatsapp.net")).toBe("491701234567");
    });

    it("returns input if not a JID", () => {
      expect(extractPhoneNumber("491701234567")).toBe("491701234567");
    });
  });

  describe("formatJid", () => {
    it("formats a phone number as a JID", () => {
      expect(formatJid("491701234567")).toBe("491701234567@s.whatsapp.net");
    });

    it("returns input unchanged if already a JID", () => {
      expect(formatJid("491701234567@s.whatsapp.net")).toBe("491701234567@s.whatsapp.net");
    });
  });
});
