/**
 * WhatsApp Whitelist Tests.
 *
 * Verifies:
 * - Whitelisted number → isWhitelisted returns true
 * - Non-whitelisted → isWhitelisted returns false
 * - Phone number extraction from JID
 * - JID formatting
 * - Number normalization (+, spaces, hyphens)
 * - Map-based whitelist (WHATSAPP_WHITELIST)
 * - resolveSenderName (name from map, fallback to formatted number)
 * - Backward compatibility: legacy WHATSAPP_WHITELIST_NUMBER still works
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isWhitelisted,
  hasWhitelist,
  normalizeNumber,
  resolveSenderName,
  extractPhoneNumber,
  formatJid,
} from "../../src/whatsapp/whitelist.js";

describe("WhatsApp Whitelist", () => {
  const originalWhitelistNumber = process.env.WHATSAPP_WHITELIST_NUMBER;
  const originalWhitelist = process.env.WHATSAPP_WHITELIST;

  beforeEach(() => {
    delete process.env.WHATSAPP_WHITELIST_NUMBER;
    delete process.env.WHATSAPP_WHITELIST;
  });

  afterEach(() => {
    if (originalWhitelistNumber !== undefined) {
      process.env.WHATSAPP_WHITELIST_NUMBER = originalWhitelistNumber;
    } else {
      delete process.env.WHATSAPP_WHITELIST_NUMBER;
    }
    if (originalWhitelist !== undefined) {
      process.env.WHATSAPP_WHITELIST = originalWhitelist;
    } else {
      delete process.env.WHATSAPP_WHITELIST;
    }
  });

  // ─── Number normalization ───

  describe("normalizeNumber", () => {
    it("strips leading +", () => {
      expect(normalizeNumber("+491701234567")).toBe("491701234567");
    });

    it("strips spaces", () => {
      expect(normalizeNumber("49 170 1234567")).toBe("491701234567");
    });

    it("strips hyphens", () => {
      expect(normalizeNumber("49170-123-4567")).toBe("491701234567");
    });

    it("strips parentheses", () => {
      expect(normalizeNumber("(49170) 123-4567")).toBe("491701234567");
    });

    it("returns empty string for non-numeric input", () => {
      expect(normalizeNumber("abc")).toBe("");
    });

    it("handles already clean numbers", () => {
      expect(normalizeNumber("491701234567")).toBe("491701234567");
    });
  });

  // ─── Legacy single-number whitelist ───

  describe("isWhitelisted (legacy WHATSAPP_WHITELIST_NUMBER)", () => {
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

    it("matches despite + prefix in env var", () => {
      process.env.WHATSAPP_WHITELIST_NUMBER = "+491701234567";
      expect(isWhitelisted("491701234567@s.whatsapp.net")).toBe(true);
    });

    it("matches despite spaces/hyphens in env var", () => {
      process.env.WHATSAPP_WHITELIST_NUMBER = "49 170-1234567";
      expect(isWhitelisted("491701234567@s.whatsapp.net")).toBe(true);
    });
  });

  // ─── Map-based whitelist ───

  describe("isWhitelisted (WHATSAPP_WHITELIST map)", () => {
    it("returns true for a number in the map", () => {
      process.env.WHATSAPP_WHITELIST = '{"491701234567":"Philipp"}';
      expect(isWhitelisted("491701234567@s.whatsapp.net")).toBe(true);
    });

    it("returns false for a number not in the map", () => {
      process.env.WHATSAPP_WHITELIST = '{"491701234567":"Philipp"}';
      expect(isWhitelisted("491709998887@s.whatsapp.net")).toBe(false);
    });

    it("matches multiple numbers in the map", () => {
      process.env.WHATSAPP_WHITELIST = '{"491701234567":"Philipp","491709998887":"Anna"}';
      expect(isWhitelisted("491701234567@s.whatsapp.net")).toBe(true);
      expect(isWhitelisted("491709998887@s.whatsapp.net")).toBe(true);
      expect(isWhitelisted("491701111111@s.whatsapp.net")).toBe(false);
    });

    it("normalizes map keys for comparison", () => {
      process.env.WHATSAPP_WHITELIST = '{"+49 170 123-4567":"Philipp"}';
      expect(isWhitelisted("491701234567@s.whatsapp.net")).toBe(true);
    });

    it("takes precedence over legacy WHATSAPP_WHITELIST_NUMBER", () => {
      process.env.WHATSAPP_WHITELIST = '{"491701234567":"Philipp"}';
      process.env.WHATSAPP_WHITELIST_NUMBER = "491709998887"; // different, would be false
      expect(isWhitelisted("491701234567@s.whatsapp.net")).toBe(true);
      expect(isWhitelisted("491709998887@s.whatsapp.net")).toBe(false);
    });
  });

  // ─── resolveSenderName ───

  describe("resolveSenderName", () => {
    it("returns the name from the map", () => {
      process.env.WHATSAPP_WHITELIST = '{"491701234567":"Philipp"}';
      expect(resolveSenderName("491701234567@s.whatsapp.net")).toBe("Philipp");
    });

    it("returns formatted phone number as fallback when no map", () => {
      process.env.WHATSAPP_WHITELIST_NUMBER = "491701234567";
      expect(resolveSenderName("491701234567@s.whatsapp.net")).toBe("+491701234567");
    });

    it("returns formatted phone number as fallback for legacy env", () => {
      process.env.WHATSAPP_WHITELIST_NUMBER = "491701234567";
      expect(resolveSenderName("491709998887@s.whatsapp.net")).toBe("+491709998887");
    });
  });

  // ─── hasWhitelist ───

  describe("hasWhitelist", () => {
    it("returns false when no env var is set", () => {
      expect(hasWhitelist()).toBe(false);
    });

    it("returns true when legacy env var is set", () => {
      process.env.WHATSAPP_WHITELIST_NUMBER = "491701234567";
      expect(hasWhitelist()).toBe(true);
    });

    it("returns true when map env var is set", () => {
      process.env.WHATSAPP_WHITELIST = '{"491701234567":"Philipp"}';
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
