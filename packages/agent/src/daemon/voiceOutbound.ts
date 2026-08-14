/**
 * Daemon-seitige Logik für Outbound-Voice-Calls (call_user).
 *
 * Enthält:
 *  - Registry-Gate (fail-closed): $HARNESS_HOME/voice-registry.json.
 *    Fehlende/kaputte Datei oder nicht gelistete Nummer → Error, NIE ein Call.
 *  - Rate-Limit: max. 1 Call pro Nummer pro 10 Minuten, persistiert in
 *    $HARNESS_STATE/voice-ratelimit.json (restart-sicher).
 *
 * Beides wird vom Daemon vor dem `start_call`-IPC ausgeführt — der Adapter
 * bleibt ein dummer Audio-Adapter und kennt keine Registry.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Registry-Format: { "contacts": [ { "number", "name"?, "note"? } ] } */
export interface VoiceRegistryContact {
  number: string;
  name?: string;
  note?: string;
}

export interface VoiceRegistry {
  contacts: VoiceRegistryContact[];
}

export const OUTBOUND_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/** Normalisiert eine Rufnummer auf Ziffern: "+49 151 10619636" → "4915110619636". */
export function normalizeVoiceNumber(raw: string): string {
  return raw.replace(/\D/g, "");
}

export type VoiceRegistryLoadResult =
  | { ok: true; contacts: VoiceRegistryContact[] }
  | { ok: false; error: string };

/**
 * Lädt die Voice-Registry — fail-closed.
 *
 * Fehlende Datei, kaputtes JSON oder fehlendes `contacts`-Array führen zu
 * `{ ok: false }`. Eine leere Kontaktliste ist gültig (erlaubt dann aber
 * keinen einzigen Call — fail-closed bei leerer Allowlist).
 */
export async function loadVoiceRegistry(registryPath: string): Promise<VoiceRegistryLoadResult> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf-8");
  } catch {
    return { ok: false, error: "voice-registry.json nicht gefunden (fail-closed)." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "voice-registry.json ist kein gültiges JSON (fail-closed)." };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "voice-registry.json hat ein ungültiges Format (fail-closed)." };
  }
  const contactsRaw = (parsed as Record<string, unknown>).contacts;
  if (!Array.isArray(contactsRaw)) {
    return { ok: false, error: "voice-registry.json fehlt das contacts-Array (fail-closed)." };
  }

  const contacts: VoiceRegistryContact[] = [];
  for (const item of contactsRaw) {
    if (item === null || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.number !== "string") continue;
    const number = normalizeVoiceNumber(c.number);
    if (!number) continue;
    const contact: VoiceRegistryContact = { number };
    if (typeof c.name === "string") contact.name = c.name;
    if (typeof c.note === "string") contact.note = c.note;
    contacts.push(contact);
  }

  return { ok: true, contacts };
}

/** Sucht einen Kontakt per normalisierter Nummer (digits-only). */
export function findRegistryContact(
  contacts: VoiceRegistryContact[],
  number: string,
): VoiceRegistryContact | undefined {
  const normalized = normalizeVoiceNumber(number);
  return contacts.find((c) => c.number === normalized);
}

/**
 * Erkennt den Owner/Betreiber der Installation anhand des Registry-Kontakts
 * (note === "Betreiber", normalisiert: trim + lowercase). Der Owner ist vom
 * Outbound-Rate-Limit ausgenommen — er darf jederzeit anrufen.
 */
export function isOwnerContact(contact: VoiceRegistryContact): boolean {
  if (!contact.note) return false;
  return contact.note.trim().toLowerCase() === "betreiber";
}

/* ─── Rate-Limit ─── */

interface VoiceRateLimitState {
  /** Normalisierte Nummer → ms-Epoch des letzten Calls. */
  [number: string]: number;
}

async function readRateLimitState(ratelimitPath: string): Promise<VoiceRateLimitState> {
  try {
    const raw = await readFile(ratelimitPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const state: VoiceRateLimitState = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          state[key] = value;
        }
      }
      return state;
    }
  } catch {
    // Missing or corrupt file → empty state (first call allowed).
  }
  return {};
}

async function writeRateLimitState(ratelimitPath: string, state: VoiceRateLimitState): Promise<void> {
  await mkdir(dirname(ratelimitPath), { recursive: true });
  const tmp = `${ratelimitPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await rename(tmp, ratelimitPath);
}

export type VoiceRateLimitResult =
  | { ok: true }
  | { ok: false; error: string; retryAfterMs: number };

/**
 * Prüft das Rate-Limit (max. 1 Call pro Nummer pro Fenster) und persistiert
 * den Call-Zeitstempel bei Erfolg. Restart-sicher über die State-Datei.
 */
export async function checkAndRecordRateLimit(
  ratelimitPath: string,
  number: string,
  nowMs: number = Date.now(),
  windowMs: number = OUTBOUND_RATE_LIMIT_WINDOW_MS,
): Promise<VoiceRateLimitResult> {
  const normalized = normalizeVoiceNumber(number);
  const state = await readRateLimitState(ratelimitPath);
  const lastCall = state[normalized];
  if (typeof lastCall === "number") {
    const remaining = windowMs - (nowMs - lastCall);
    if (remaining > 0) {
      const retryAfterMs = Math.max(0, remaining);
      const sec = Math.ceil(retryAfterMs / 1000);
      return {
        ok: false,
        error:
          `Rate-Limit: ${normalized} wurde vor Kurzem angerufen. ` +
          `Nächster Call in ${Math.floor(sec / 60)} min ${sec % 60} s möglich.`,
        retryAfterMs,
      };
    }
  }

  state[normalized] = nowMs;
  await writeRateLimitState(ratelimitPath, state);
  return { ok: true };
}

/** Entfernt den letzten-Call-Eintrag einer Nummer (für Tests/Cleanup). */
export async function clearRateLimit(
  ratelimitPath: string,
  number: string,
): Promise<void> {
  const normalized = normalizeVoiceNumber(number);
  const state = await readRateLimitState(ratelimitPath);
  if (normalized in state) {
    delete state[normalized];
    await writeRateLimitState(ratelimitPath, state);
  }
}
