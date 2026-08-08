/**
 * WhatsApp Whitelist and Phone Number Utilities.
 *
 * Supports two configuration modes:
 * 1. `WHATSAPP_WHITELIST` env var — JSON map of phone number → display name,
 *    e.g. `{"491701234567":"Philipp", "491709998887":"Anna"}`.
 * 2. `WHATSAPP_WHITELIST_NUMBER` env var (legacy) — single phone number,
 *    no display name. Used only when `WHATSAPP_WHITELIST` is not set.
 *
 * Both sides are normalized to digits-only for comparison (strips +, spaces,
 * hyphens, etc.). Non-whitelisted senders → silent drop (log, never respond).
 */

/** Whitelist map: normalized phone number → display name. Lazily loaded from env. */
export interface WhitelistMap {
  [normalizedNumber: string]: string;
}

function parseWhitelistEnv(): WhitelistMap | null {
  const raw = process.env.WHATSAPP_WHITELIST;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const map: WhitelistMap = {};
    for (const [number, name] of Object.entries(parsed)) {
      const normalized = normalizeNumber(number);
      if (normalized) {
        map[normalized] = name;
      }
    }
    return map;
  } catch {
    return null;
  }
}

function loadWhitelistMap(): WhitelistMap | null {
  return parseWhitelistEnv();
}

/** Legacy single-number env var. Lazy read for testability. */
function getWhitelistedNumber(): string {
  return process.env.WHATSAPP_WHITELIST_NUMBER ?? "";
}

/**
 * Normalizes a phone number to digits-only for comparison.
 * Strips leading +, spaces, hyphens, parentheses, and other non-digit characters.
 * " +49 (170) 123-4567 " → "491701234567"
 */
export function normalizeNumber(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Checks whether a JID belongs to a whitelisted number.
 * Uses `WHATSAPP_WHITELIST` map if configured, falls back to legacy
 * `WHATSAPP_WHITELIST_NUMBER`. Returns false for all others (silent drop).
 */
export function isWhitelisted(jid: string): boolean {
  const phone = normalizeNumber(extractPhoneNumber(jid));
  if (!phone) return false;

  const map = loadWhitelistMap();
  if (map) {
    return phone in map;
  }

  // Legacy: single-number env var
  const whitelisted = normalizeNumber(getWhitelistedNumber());
  if (!whitelisted) return false;
  return phone === whitelisted;
}

/** Returns true if a whitelist is configured at all. */
export function hasWhitelist(): boolean {
  if (loadWhitelistMap()) return true;
  return normalizeNumber(getWhitelistedNumber()).length > 0;
}

/**
 * Resolves the display name for a whitelisted JID.
 * Returns the configured name from the map, or the raw phone number as fallback.
 * Call only for JIDs that passed isWhitelisted().
 */
export function resolveSenderName(jid: string): string {
  const phone = normalizeNumber(extractPhoneNumber(jid));
  const map = loadWhitelistMap();
  if (map && phone in map) {
    return map[phone]!;
  }
  // Fallback: formatted phone number
  const raw = extractPhoneNumber(jid);
  return raw.startsWith("+") ? raw : `+${raw}`;
}

/**
 * Extracts the phone number from a JID.
 * "491701234567@s.whatsapp.net" → "491701234567"
 * "491701234567:1@s.whatsapp.net" → "491701234567"
 */
export function extractPhoneNumber(jid: string): string {
  const atIndex = jid.indexOf("@");
  if (atIndex === -1) return jid;
  let number = jid.slice(0, atIndex);
  const colonIndex = number.indexOf(":");
  if (colonIndex !== -1) {
    number = number.slice(0, colonIndex);
  }
  return number;
}

/**
 * Formats a phone number as a WhatsApp JID.
 * "491701234567" → "491701234567@s.whatsapp.net"
 */
export function formatJid(phoneNumber: string): string {
  if (phoneNumber.includes("@")) return phoneNumber;
  return `${phoneNumber}@s.whatsapp.net`;
}
