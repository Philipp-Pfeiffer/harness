# WhatsApp Gateway v1

## Problem/Symptom

Harness sollte via WhatsApp ansprechbar werden. Bisher gab es keine
Gateway-Anbindung — der Daemon war nur über IPC (TUI/CLI) erreichbar.

## Befund

Die Codebase hatte bereits Vorabstruktur:
- `SessionOrigin` enthielt `"whatsapp"`
- `GatewayAdapter` Interface war definiert (start/stop/healthCheck/onInbound)
- `DaemonConfig.gateways: string[]` Feld existierte
- `DaemonRuntime.registerGateway()` war implementiert, aber nie aufgerufen
- Output-Pipeline für WhatsApp-Channel (4096-Zeilen, Tabellen/Code als PNG) war fertig
- Abort/Mailbox/Retry-Infrastruktur war vorhanden

Es fehlte: Plugin-Interface, Baileys-Anbindung, Media-Pipeline,
Inbound-Verarbeitung (Debounce, Abort-and-Restart), Test-Mode, Tests.

## Was geändert wurde

### Neue Module (`packages/agent/src/whatsapp/`)

- **`types.ts`** (in `daemon/types.ts` erweitert): `ChannelPlugin` Interface
  (erweitert `GatewayAdapter` um `channel` + `sendMessage`), `ChannelPluginContext`,
  `ChannelInboundEvent`, `InboundMedia`, `InboundImageBlock`, `SessionScope`,
  `WhatsAppConfig` in `DaemonConfig` erweitert.

- **`limits.ts`**: Zentrale Limits — `MAX_MEDIA_DOWNLOAD_BYTES` (100MB),
  `OUTBOUND_CHUNK_DELAY_MS` (500ms), `INBOUND_DEBOUNCE_MS` (1s),
  `ABORT_RESTART_WINDOW_MS` (5s), `MAX_RESTARTS_PER_TURN` (2),
  `SESSION_INACTIVITY_THRESHOLD_MS` (8h), Reconnect-Backoff-Konstanten.

- **`client.ts`**: Baileys-Client-Wrapper mit Pairing-Code-Auth (kein QR),
  Session-Persistence via `useMultiFileAuthState` unter `$STATE/whatsapp/`,
  Reconnect mit exponentiellem Backoff. Inbound nur `!fromMe`.
  Exportiert `createMockWhatsAppClient()` für Tests.

- **`whitelist.ts`**: Hartkodierte Whitelist via `WHATSAPP_WHITELIST_NUMBER` env var.
  Silent Drop für alle nicht-whitelisted Absender (loggen, NIEMALS antworten).
  `extractPhoneNumber()`, `formatJid()`, `isWhitelisted()`.

- **`media.ts`**: Media-Download-Pipeline. Dateibenennung
  `YYYY-MM-DD_HH-mm-ss_<4 Zufallszeichen>.<ext>`. 100MB-Cap via
  `MediaTooLargeError`. `isVisionCapableModel()` checkt modell-spezifische
  Vision-Support. `processMediaForTurn()` erstellt Image-Blocks für
  vision-fähige Modelle + Annotations für alle Medientypen.

- **`voice.ts`**: Voice-Transkription via AssemblyAI. API-Key aus
  `process.env.ASSEMBLYAI_API_KEY`. Upload → Submit → Poll → Transcript.
  Key fehlt → `null` (Annotation „Transkription nicht verfügbar").
  Audio-DATEIEN (ptt:false) → normale Media-Behandlung.

- **`outbound.ts`**: Rendert Agent-Output via `renderToChannel(markdown, "whatsapp")`
  und sendet sequenziell mit `OUTBOUND_CHUNK_DELAY_MS` Delay zwischen Chunks.

- **`inbound.ts`**: `WhatsAppInboundProcessor` — das Herzstück.
  - **Debounce**: 1s-Fenster, Nachrichten-Bursts → ein Turn.
  - **Abort-and-Restart**: Neue Nachricht <5s nach Turn-Start, kein Tool ausgeführt
    → interne Abortion + Restart mit kombiniertem Kontext. Max 2 Restarts,
    danach Steer via Mailbox. Nach erstem Tool-Call: nur Steer.
  - **8h-Compaction**: Session inaktiv >8h → Compaction-Prompt vor dem Turn.
    TODO-Hook für Memory-Destillation der abgelaufenen Session.
  - **Test-Mode**: Keine Agent-Turns. Strukturierte Logs (Absender, Typ,
    ptt-Flag, Sticker-Erkennung, Media-Download). Echo an whitelisted Absender.

- **`plugin.ts`**: `createWhatsAppPlugin()` — ChannelPlugin-Implementierung.
  Verbindet Baileys-Client, Media-Pipeline, Voice-Transkription, Whitelist,
  Inbound-Processor und Outbound-Renderer.

### Agent-Loop (`packages/core/src/core/agent.ts`)

- `RunOptions.internalAbortSignal` hinzugefügt — für Gateway-Initiierte Restarts.
- `RunResult` um `reason: "internal_restart"` erweitert.
- An allen 3 Abort-Check-Points + Stream-Catch: `internalAbortSignal` wird VOR
  `signal` geprüft. Bei internem Abort:
  - KEIN `pushAbortAnnotation` (kein User-Abort)
  - KEIN `discardMailbox` (Mailbox überlebt Restart)
  - Partial-Output wird verworfen (gleiche Invariante wie Retry-Run)
  - Return: `{ aborted: true, reason: "internal_restart" }`

### Retry-Policy (`packages/core/src/core/retryPolicy.ts`)

- `ErrorClass` um `"internal_restart"` erweitert.
- `classifyError()` akzeptiert jetzt `internalAbortSignal` als 3. Parameter,
  wird VOR `userSignal` geprüft. `"internal_restart"` ist nie retryable.
- `TimeoutController` akzeptiert optionalen `internalSignal`, propagiert
  Abbruch ohne `timedOut` zu setzen.

### Paths (`packages/core/src/config/paths.ts`)

- `paths.inboundMedia` = `$STATE/inbound-media/`
- `paths.whatsapp` = `$STATE/whatsapp/`
- Beide in `ensureDirs()` aufgenommen.

### Prompts (`packages/core/prompts/session-compaction.md`)

- Neuer Compaction-Prompt für 8h-Session-Grenze („Session-Grenze erreicht").

### Daemon-Wiring (`packages/agent/src/daemon/runtime.ts`)

- `initGateways()` in `start()` nach `initAgent()` aufgerufen.
- `initWhatsAppGateway()`: Erstellt `createWhatsAppPlugin()` mit Callbacks
  für Session-Resolution, Turn-Submission, Compaction und Steering.
- `submitWhatsAppTurn()`: Submittet Turns mit Image-Content-Blocks.
- `resolveWhatsAppSession()`: Persistente Session pro Chat (Phone → Session-ID).
- `compactWhatsAppSession()`: Triggert `compactSession()` bei 8h-Inaktivität.
- `steerWhatsAppSession()`: Pushed Steer-Nachrichten in die Session-Mailbox.

### Dependency

- `baileys@7.0.0-rc13` zu `packages/agent` hinzugefügt.

## Welche Dateien

- `packages/agent/src/whatsapp/limits.ts` (neu)
- `packages/agent/src/whatsapp/whitelist.ts` (neu)
- `packages/agent/src/whatsapp/media.ts` (neu)
- `packages/agent/src/whatsapp/voice.ts` (neu)
- `packages/agent/src/whatsapp/client.ts` (neu)
- `packages/agent/src/whatsapp/outbound.ts` (neu)
- `packages/agent/src/whatsapp/inbound.ts` (neu)
- `packages/agent/src/whatsapp/plugin.ts` (neu)
- `packages/agent/src/whatsapp/index.ts` (neu)
- `packages/agent/src/daemon/types.ts` (erweitert)
- `packages/agent/src/daemon/runtime.ts` (erweitert)
- `packages/core/src/core/agent.ts` (erweitert)
- `packages/core/src/core/retryPolicy.ts` (erweitert)
- `packages/core/src/config/paths.ts` (erweitert)
- `packages/core/prompts/session-compaction.md` (neu)
- `packages/agent/package.json` (baileys dependency)
- `pnpm-workspace.yaml` (baileys allowBuilds)

### Tests (neu)

- `packages/agent/tests/whatsapp/whitelist.test.ts`
- `packages/agent/tests/whatsapp/media.test.ts`
- `packages/agent/tests/whatsapp/inbound.test.ts`

## Tests

- Whitelist: whitelisted/non-whitelisted, phone extraction, JID formatting
- Media: naming schema + collision-freedom, 100MB cap, MIME mapping, vision check
- Inbound: debounce, abort-and-restart (restart-then-steer, max 2 restarts, >5s no restart),
  8h compaction trigger, test-mode echo + structured logs, ptt/sticker detection
- Baileys socket in tests IMMER gemockt — keine echte WhatsApp-Verbindung
