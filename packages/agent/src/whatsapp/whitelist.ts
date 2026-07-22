/**
 * WhatsApp Whitelist and Phone Number Utilities.
 *
 * MVP: hardcoded single whitelist number via env var.
 * Non-whitelisted senders → silent drop (log, never respond).
 */

/** Whitelisted phone number (from env, never hardcoded). Lazy read for testability. */
function getWhitelistedNumber(): string {
  return process.env.WHATSAPP_WHITELIST_NUMBER ?? "";
}

/**
 * Checks whether a JID belongs to the whitelisted number.
 * Returns false for all others (silent drop).
 */
export function isWhitelisted(jid: string): boolean {
  const whitelisted = getWhitelistedNumber();
  if (!whitelisted) return false;
  const phone = extractPhoneNumber(jid);
  return phone === whitelisted;
}

/** Returns true if a whitelist is configured at all. */
export function hasWhitelist(): boolean {
  return getWhitelistedNumber().length > 0;
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
