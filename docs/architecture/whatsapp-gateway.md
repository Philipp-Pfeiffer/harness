# WhatsApp Gateway

**Stand:** 2026-07-22 · **Files:** `packages/agent/src/whatsapp/` (client.ts, whitelist.ts, media.ts, voice.ts, outbound.ts, inbound.ts, plugin.ts, limits.ts), `packages/agent/src/daemon/types.ts`, `packages/agent/src/daemon/runtime.ts`, `packages/core/src/tools/send_file.ts`

## Überblick

Das WhatsApp Gateway ist als Channel-Plugin implementiert — kein Festverdrahtung im Daemon. `WhatsAppChannelPlugin` implementiert das `ChannelPlugin`-Interface (erweitert `GatewayAdapter` um `sendMessage` und `getFileCapabilities`). Der Daemon registriert Plugins über eine Registry; WhatsApp ist die erste Implementierung.

Baileys (Node.js WhatsApp-Web-Protokoll) dient als Transport. Authentifizierung via Pairing-Code (kein QR).

## Config

In `~/harness/config.json` den `daemon`-Key erweitern:

```json
{
  "daemon": {
    "gateways": ["whatsapp"],
    "whatsapp": {
      "testMode": true,
      "phoneNumber": "4915112345678"
    }
  }
}
```

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `gateways` | `string[]` | Aktive Gateways. `["whatsapp"]` aktiviert das WhatsApp-Plugin. |
| `whatsapp.testMode` | `boolean` | `true` = keine Agent-Turns, Echo + strukturierte Logs. Für Erst-Setup und Verifikation. |
| `whatsapp.phoneNumber` | `string` | Eigene Handynummer im internationalen Format ohne `+`. Für Pairing-Code-Auth. |

**Hot-reload:** Gateway-Änderungen (hinzufügen/entfernen) erfordern Daemon-Restart. `testMode` kann per `reload-config` nicht toggeln — Restart nötig.

## Env-Variablen

| Variable | Erforderlich | Beschreibung |
|----------|-------------|--------------|
| `WHATSAPP_WHITELIST` | Ja* | JSON-Map `{"<Nummer>":"<Name>", ...}`. Nachrichten von Nummern in der Map → normaler Agent-Turn. Alle anderen → Silent Drop (loggen, nie antworten). Nummern werden digits-only normalisiert (ignoriert `+`, Leerzeichen, Bindestriche). |
| `WHATSAPP_WHITELIST_NUMBER` | Ja* (Legacy) | Einzelne Whitelist-Nummer (international, `+` optional). Wird ignoriert, wenn `WHATSAPP_WHITELIST` gesetzt ist. |
| `ASSEMBLYAI_API_KEY` | Nein | Für Voice-Nachrichten-Transkription. Fehlt → Annotation „Transkription nicht verfügbar" + Datei-Pfad. |

*Entweder `WHATSAPP_WHITELIST` oder `WHATSAPP_WHITELIST_NUMBER` muss gesetzt sein.

**Beispiel `WHATSAPP_WHITELIST`:**
```bash
WHATSAPP_WHITELIST='{"4915112345678":"Philipp","447700900123":"Anna"}'
```

## Sender-Provenienz (Provenance Prefix)

Jede Inbound-Nachricht wird vor dem Agent-Turn mit einem Provenienz-Präfix versehen:

- **Mit Name in der Map:** `[WhatsApp · Philipp] <nachricht>`
- **Ohne Name (Legacy-Env):** `[WhatsApp · +491511…] <nachricht>`

Das Modell erkennt so strukturell, dass die Nachricht von einem externen Channel kommt und von wem. Der Präfix wird in `WhatsAppInboundProcessor.flushDebounced()` (inbound.ts) gesetzt, also vor dem ersten Turn-Start und nach dem Debounce.

## Ersteinrichtung / Pairing

1. Config + Env setzen (siehe oben).
2. `pnpm build` ( beide Packages).
3. Daemon starten: `harness daemon start` oder im Vordergrund: `node packages/agent/dist/index.js daemon run`.
4. Beim ersten Start: **Pairing-Code** erscheint im Daemon-Log (`$HARNESS_STATE/logs/daemon-YYYY-MM-DD.log`).
5. Code in WhatsApp eingeben: *Einstellungen → Verknüpfte Geräte → Gerät verknüpfen → Mit Telefonnummer verknüpfen*.
6. Session wird persistiert unter `$HARNESS_STATE/whatsapp/` (via `useMultiFileAuthState`). Bei Daemon-Restart: kein Re-Pairing nötig.

## Test-Mode

`testMode: true` — verifiziert Ende-zu-Ende, während OpenClaw noch als Linked Device läuft:

- **Pairing + Empfang** laufen normal.
- **Keine Agent-Turns** — Inbound wird nicht an den Agent geschickt.
- **Strukturierte Logs**: Absender, Message-Typ, ptt-Flag, Sticker-Erkennung, Media-Download-Ergebnis (Pfad, Größe), Whitelist-Entscheidung.
- **Echo an whitelisted Absender**:
  - Text → `[test] empfangen: text, <n> Zeichen`
  - Media → `[test] Media gespeichert: <Dateiname>`
- **Nicht-whitelisted Absender**: Silent Drop (loggen, keine Antwort).
- Sticker → nur Log + Datei, kein Echo.

## Inbound-Verarbeitung

### Text
Text → Debounce (1s) → Agent-Turn → Antwort via Channel Output Pipeline (4096-Chunking, Tabellen/Code als PNG via satori→resvg).

### Media (Bilder, PDFs, ZIPs, Audio, Video)
- Download nach `$HARNESS_STATE/inbound-media/`
- Naming: `YYYY-MM-DD_HH-mm-ss_<4 Zufallszeichen>.<ext>`
- Max-Download-Cap: 100 MB (zentralisiert in `limits.ts`)
- Annotation im Turn: „Datei angehängt: <Pfad> (<Typ>, <Größe>). Schau sie dir bei Bedarf an."
- Bilder bei vision-fähigem Modell: zusätzlicher Image-Content-Block direkt im Turn
- Sticker (`stickerMessage`): nur Log + Datei, kein Turn

### Voice
- `audioMessage` mit `ptt: true` → AssemblyAI-Transkription → Transkript als Text in den Turn (gekennzeichnet als Voice-Nachricht)
- `ptt: false` oder fehlt → normale Media-Behandlung
- API-Key fehlt → Annotation „Voice-Nachricht empfangen, Transkription nicht verfügbar" + Datei-Pfad

## Session-Verhalten

- **Persistente Dauer-Session** pro Chat (Phone-Nummer → Session-ID).
- **8h-Inaktivität**: Nächste Nachricht nach >8h Inaktivität triggert Compaction mit eigenem Prompt (*„Session-Grenze erreicht — fasse zusammen, was in der letzten Session passiert ist"*).
- **Memory-Destillation**: Hook-Punkt + TODO in `runtime.ts:compactWhatsAppSession()` — Pipeline-Anbindung ist nicht Teil von v1.

## Steer / Debounce / Abort-and-Restart

| Mechanismus | Bedingung | Verhalten |
|-------------|-----------|-----------|
| **Debounce** | Mehrere Nachrichten innerhalb 1s | Bursts → ein Turn |
| **Abort-and-Restart** | Neue Nachricht <5s nach Turn-Start UND kein Tool ausgeführt | Generation abbrechen + Turn mit erweitertem Kontext neu starten. Prefix identisch → Prompt-Cache-Hit. Max 2 Restarts. |
| **Steer** | Neue Nachricht nach erstem Tool-Call ODER nach 2 Restarts | Steer-Injection via Mailbox (`steerWhatsAppSession`) |
| **Partial-Output** | Bei Abort | Vollständig verworfen — nichts landet in `context.messages` vor erfolgreichem Abschluss |
| **User-Abort** | — | Interner Abort ist KEIN User-Abort: `pushAbortAnnotation` springt nicht an, `internalAbortSignal` wird VOR `signal` geprüft, Retry-Klassifizierung wertet ihn als `internal_restart`, nicht als `user_abort` |

## Outbound

- Agent-Output → `renderToChannel(markdown, "whatsapp")` → `RenderResult` mit `.messages` (inkl. Attachments = PNG-Renderings)
- `sendAgentResponse()` sendet Text + Attachments sequenziell mit 500ms Delay (Anti-Ban)
- Attachment-Send-Fehler → Text-Fallback-Hinweis (`[Tabelle konnte nicht gesendet werden]`) — nie stiller Verlust
- `send_file`-Tool: Agent kann beliebige Dateien senden. Channel-aware: MIME-Support wird gegen Capability-Matrix geprüft.

## Anti-Ban-Maßnahmen

- Alle Outbound-Chunks/Media sequenziell mit 500ms Delay (`OUTBOUND_CHUNK_DELAY_MS`)
- Kein Parallel-Send, kein Rapid-Fire
- Whitelist: hartkodierte Nummer. Nicht-whitelisted → NIEMALS antworten, nur loggen
- Reconnect mit exponentiellem Backoff (1s Basis, 30s Max)

## Module

| Datei | Verantwortung |
|-------|--------------|
| `limits.ts` | Alle Konstanten (Caps, Delays, Thresholds) |
| `client.ts` | Baileys-Client Wrapper: Pairing, Persistence, Reconnect, sendFile + `baileysMessageType()` MIME→Typ Mapping |
| `whitelist.ts` | `isWhitelisted(jid)`, `extractPhoneNumber(jid)`, `formatJid(phone)` |
| `media.ts` | `downloadMedia()`, `generateMediaFilename()`, `isVisionCapableModel()` (Config-Flag gewinnt über Namens-Heuristik), `processMediaForTurn()`, `MediaTooLargeError` |
| `voice.ts` | `transcribeVoice(filePath)` via AssemblyAI |
| `outbound.ts` | `sendAgentResponse()`: rendert + sendet Text & Attachments sequenziell, Text-Fallback bei Fehlern |
| `inbound.ts` | `WhatsAppInboundProcessor`: Debounce, Abort-and-Restart, 8h-Compaction, Test-Mode |
| `plugin.ts` | `createWhatsAppPlugin()`: ChannelPlugin-Implementierung. Verbindet alle Module. |

## Capabilities

WhatsApp Channel-Konfiguration in `packages/agent/src/output/capabilities.ts`:

| Capability | Wert |
|------------|------|
| `maxMessageLength` | 4096 |
| `supportsSticker` | true |
| `maxFileSize` | 100 MB |
| `supportedFilePrefixes` | image/*, audio/*, video/*, application/pdf, application/zip, ... |

## Path-Layout

| Pfad | Inhalt |
|------|--------|
| `$HARNESS_STATE/whatsapp/` | Baileys Auth-State (Session-Persistence) |
| `$HARNESS_STATE/inbound-media/` | Heruntergeladene Media-Dateien |

## Tests

- Baileys wird in Tests **immer** gemockt via `createMockWhatsAppClient()` — keine echte WhatsApp-Verbindung.
- Test-Dateien in `packages/agent/tests/whatsapp/`: whitelist, media, client, outbound, send_file, inbound.
- Kein E2E-Test mit echter Verbindung — nur Mock-basierte Unit/Integration-Tests.
