# feat: WhatsApp Presence-Updates (composing-Indikator + Online-Status)

## Problem/Symptom

- Der Agent zeigt während eines Turns keinen "tippt…"-Indikator. Bei langen Turns (30–120s LLM-Latenz, Tool-Calls) sieht der Nutzer keine Rückmeldung, ob die Nachricht verarbeitet wird.
- Der Daemon meldet keinen Online-Status an WhatsApp: Weder "available" beim Verbinden noch "unavailable" beim Disconnect/Shutdown.

## Hintergrund

Der JID `:0`-Suffix-Fix (`d301efe`, deployed) war die eigentliche Ursache des "Warte auf diese Nachricht"-Problems — nicht die Presence-Updates. Die frühere Implementierung (`sendTyping` mit `sock.sendPresenceUpdate("composing", jid)` bei Inbound-Start) wurde in `f6f9dc4` entfernt, weil der Indikator bei 30–120s LLM-Latenz auslief. Mit dem JID-Fix ist der Sendepfad stabil; Presence kann gefahrlos wieder rein — diesmal aber mit Refresh-Interval.

## Fix

### 1. Composing-Indikator (pro Turn)

- `inbound.ts` (`WhatsAppInboundProcessor`): Bei Turn-Start (Flush der Debounce-Window bzw. First-Turn-nach-Rotation) wird `setPresence("composing", source)` gesendet.
- Refresh-Interval alle `PRESENCE_COMPOSING_REFRESH_MS = 15_000` ms, solange der Turn läuft (WhatsApp-Composing läuft nach ~20-30s aus).
- Bei Turn-Ende (`handleTurnComplete`, auch bei Fehler) wird das Interval gecleart und `setPresence("paused", source)` gesendet.
- Abort-and-Restart: Der Turn läuft weiter → Indikator bleibt aktiv, kein Neustart des Intervals nötig.
- Fire-and-forget: Presence-Fehler können nie einen Turn failen.

### 2. Online-Status (Account-weit)

- `plugin.ts` (`onConnectionUpdate`): `open` → `setPresence("available")`, `close` → `setPresence("unavailable")`.
- `runtime.ts` (`shutdownWithExit`): Nach dem Stoppen der Gateways `setWhatsAppPresence("unavailable")`, damit beim Daemon-Shutdown offline gemeldet wird (nur bei vorhandenem Plugin; Fehler sind warn-only).
- Neue Plugin-Methode `setPresence(type: "available" | "unavailable", jid?)`; `runtime.setWhatsAppPresence` routet darüber (Guard: Plugin ohne `setPresence` → Skip).

### 3. Client

- `client.ts`: `sendPresenceUpdate(type: WAPresence, jid?)` auf der `WhatsAppClient`-Interface + Mock, Wrapper um `sock.sendPresenceUpdate` mit warn-Log bei Fehler. `WAPresence` wird aus Baileys re-exportiert.

## Dateien

- `packages/agent/src/whatsapp/client.ts`
- `packages/agent/src/whatsapp/plugin.ts`
- `packages/agent/src/whatsapp/inbound.ts`
- `packages/agent/src/whatsapp/limits.ts`
- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/tests/whatsapp/inbound.test.ts`
- `packages/agent/tests/whatsapp/socketOptions.test.ts`

## Tests

- `pnpm build`, `pnpm typecheck` grün
- `CI=true pnpm --filter @harness/agent test` grün
- Neue Tests: composing bei Turn-Start, Refresh alle 15s, kein Refresh nach Turn-Ende, kein composing bei leerem Turn, `sendPresenceUpdate`-Forwarding auf den Socket
