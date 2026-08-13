# Voice v1.3 — Cold-Start: Accept-After-Ready + Begrüßung mit Anrufer-Kontext

## Problem/Symptom

Der Adapter nahm Inbound-Calls **sofort** an und wartete im Live-Betrieb auf
die Daemon-Begrüßung (TTS + Netz). Ergebnis: Der Anrufer hörte den ersten Ton
erst nach ~2,5 s. Zusätzlich war die Begrüßung nicht agent-generiert — der
Adapter schickte ein Fake-Transcript (`Hallo, worum geht es?`), ohne
Anrufer-Kontext.

## Lösung

**Accept-After-Ready + Begrüßung mit Anrufer-Kontext:**

1. Neues IPC-Ereignis `call_ringing` (Adapter → Daemon, VOR `acceptCall`).
2. Der Daemon löst die Nummer über `voice-registry.json` auf (unbekannt →
   `null` → Roh-Nummer), startet einen **Opening-Turn OHNE Fake-User-Message**
   mit System-Addendum ("X ruft gerade an. Sprich sofort eine kurze
   Begrüßung …") und sendet die Begrüßung als `say` — **VOR** `call_started`.
3. Der Adapter puffert das Greeting-Audio (kein Feed vor dem Accept), nimmt
   den Call erst an, wenn die Begrüßung gepuffert ist oder das Fallback-
   Timeout abläuft (`INBOUND_GREETING_TIMEOUT_MS`, Default 3 s), und feedet
   danach sofort.

## Was geändert wurde

### `packages/agent/src/daemon/types.ts`

- `VoiceInboundMessage` + `call_ringing` (`{ callId, from, ts }`).
- `VoiceChannelCallbacks` hierher verschoben (Import-Zirkel mit
  `voiceChannel.ts` vermieden) + neuer optionaler Callback `onInboundRinging`.

### `packages/agent/src/daemon/voiceRegistry.ts` (neu)

- `resolveVoiceContact(registryPath, number): Promise<string | null>` —
  Nummer→Name-Auflösung, **fail-open**: unbekannte Nummer, fehlende/kaputte
  Datei oder fehlendes `contacts`-Array → `null` (Aufrufer fällt auf die
  Roh-Nummer zurück). Gelisteter Kontakt ohne `name` → normalisierte Nummer.

### `packages/agent/src/daemon/voiceChannel.ts`

- `call_ringing`-Handler: Session via `resolveSession` bereits hier anlegen,
  `callId`→Socket binden (Begrüßung sofort zustellbar), `onInboundRinging`
  feuern.
- `call_started` nutzt die beim Ringing angelegte Session (Fallback:
  `resolveSession`).

### `packages/agent/src/daemon/runtime.ts`

- `onInboundVoiceRinging(callId, from, ts)`: Session anlegen, Name via
  `resolveVoiceContact(this.paths.voiceRegistry, from)` auflösen (Fallback
  Roh-Nummer), Opening-Turn **ohne user-Message** mit
  `inboundVoiceOpeningAddendum(name)` + Voice-Addendum, Ergebnis als `say`
  an den Adapter (der puffert). `temperature`/`maxTokens` werden bewusst
  NICHT gesetzt — die Kürze erzwingt das Addendum (max. 1 Satz).
- Fehler im Opening-Turn werden geloggt; der Call klingelt dann bis zum
  Adapter-Fallback-Timeout und wird ohne Begrüßung angenommen.

### `packages/agent/src/daemon/channelAddendum.ts`

- `inboundVoiceOpeningAddendum(callerName)`: System-Addendum für den
  Opening-Turn (Name + max. 1 Satz + danach auf den Anrufer warten).

## Tests

- `packages/agent/tests/daemon/voiceRegistry.test.ts` (neu, 6 Tests):
  Name-Auflösung, Kontakt ohne Name, unbekannte Nummer, fehlende Datei,
  kaputtes JSON/fehlendes `contacts`, Nummern-Normalisierung.
- `packages/agent/tests/daemon/voiceChannel.test.ts` (+1): `call_ringing`
  legt Session an, feuert `onInboundRinging`, `say` kommt vor `call_started`,
  anschließender Transcript-Turn nutzt dieselbe Session.
- `packages/agent/tests/daemon/voiceRuntime.test.ts` (+3): Opening-Turn mit
  Registry-Name + `say`; unbekannte Nummer → Roh-Nummer; KEIN Fake-User-Turn
  (Agent läuft ohne user-Message, Addendum enthält Name + TTS-Regeln).
- Volle Agent-Suite: 664 Tests grün; Core: 593/594 grün (1 bekannter
  Ausreißer: `exec`-elevated-Test braucht passwordless sudo — existiert auf
  Basis `eb046f5` ebenfalls, also vorbestehend).
