/**
 * Voice-Registry (Nummer → Name).
 *
 * Gemeinsame Nummer→Name-Auflösung für Inbound (Begrüßung mit Anrufer-
 * Kontext) und Outbound (Registry-Gate). Liest $HARNESS_HOME/voice-registry.json
 * (Format: { "contacts": [ { "number", "name"?, "note"? } ] }).
 *
 * Im Gegensatz zum Outbound-Gate (fail-closed: kein Kontakt → kein Call) ist
 * die Inbound-Auflösung fail-open: unbekannte Nummer → `null` → der Daemon
 * fällt auf die Roh-Nummer zurück.
 */

import { readFile } from "node:fs/promises";
import type { VoiceRegistry } from "./voiceOutbound.js";

/**
 * Löst eine Rufnummer auf einen Kontaktnamen auf.
 *
 * - Bekannte Nummer (normalisiert, digits-only) → `name` des Kontakts.
 * - Bekannte Nummer ohne `name` → die Nummer selbst.
 * - Unbekannte Nummer / fehlende oder kaputte Registry → `null` (fail-open;
 *   der Aufrufer fällt dann auf die Roh-Nummer zurück).
 */
export async function resolveVoiceContact(
  registryPath: string,
  number: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).contacts)
  ) {
    return null;
  }

  const normalized = number.replace(/\D/g, "");
  const contact = (parsed as VoiceRegistry).contacts.find(
    (c) => c.number === normalized,
  );
  if (!contact) return null;
  return contact.name ?? normalized;
}
