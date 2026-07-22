# WhatsApp Gateway v1.1 — Outbound-Media, Send-Tool & Review-Fixes

## Problem/Symptom

Der v1-WhatsApp-Gateway konnte nur Text senden — PNG-Renderings von Tabellen/Code
wurden nur geloggt, nicht an WhatsApp zugestellt. Der Agent hatte keinen Weg, aktiv
Dateien in den Chat zu schicken. Die Vision-Erkennung basierte auf Namens-Heuristik
statt auf expliziter Konfiguration.

## Befund

- `ChannelPlugin.sendMessage` war Text-only (`{ text: string; attachments?: InboundMedia[] }`).
- `sendAgentResponse()` in `outbound.ts` ignorierte `RenderedMessage.attachments`.
- Kein Tool für den Agent existierte, um Dateien zu senden.
- `isVisionCapableModel()` nutzte Provider/Name-Pattern-Matching ohne Config-Override.
- Kollisions-Test forderte nur >80% Unique (bei 65.536 Kombinationen zu schwach).

## Was geändert wurde

### 1. sendMessage-Payload erweitert

**`packages/agent/src/daemon/types.ts`**:
- `ChannelPlugin.sendMessage` akzeptiert jetzt `ChannelSendPayload`:
  `{ text?: string; files?: ChannelFile[] }`
- `ChannelFile`: `{ path?: string; buffer?: Buffer; mimeType: string; caption?: string; asSticker?: boolean }`
- `getFileCapabilities?(): ChannelFileCapabilities` Methode am Interface
- `ChannelFileCapabilities`: `{ supportedMimePrefixes; supportsSticker; maxFileSize }`

**`packages/agent/src/output/capabilities.ts`**:
- `ChannelCapabilities` um `supportedFilePrefixes`, `supportsSticker`, `maxFileSize` erweitert
- Alle 4 Channel (WhatsApp, Discord, Signal, Mail) mit konkreten Werten versehen
- `supportsMimeType(channel, mimeType)` Helper-Funktion hinzugefügt

### 2. Baileys sendFile

**`packages/agent/src/whatsapp/client.ts`**:
- `WhatsAppClient.sendFile(jid, file)` Methode zum Interface hinzugefügt
- Implementierung: MIME → Baileys Message-Typ Mapping (`baileysMessageType()`)
- `asSticker=true` → `"sticker"` Message-Typ (WebP), override unabhängig vom MIME
- `caption` wird an Baileys weitergegeben (außer für Sticker)
- Mock-Client um `sendFile` erweitert
- `baileysMessageType()` exported für Tests

### 3. Outbound-Attachments senden

**`packages/agent/src/whatsapp/outbound.ts`** (komplett neu geschrieben):
- `sendAgentResponse()` sendet jetzt Attachments als Image-Message (nicht nur loggen!)
- `RenderedMessage.attachments` (PNG-Renderings von Tabellen/Code) werden an der
  korrekten Position der Nachrichten-Sequenz gesendet
- Send-Fehler pro Attachment → Text-Fallback-Hinweis (`"[Tabelle konnte nicht gesendet werden]"`)
  — niemals stiller Verlust
- Text wird vor Attachments gesendet, Delay zwischen allen Sends (500ms)
- `SendPayloadFn` Interface für strukturierte Payloads statt einfacher Text-Funktion
- `sendRenderedMessages()` ebenfalls aktualisiert für pre-rendered Messages
- `isFileSupported(channel, mimeType)` Helper

### 4. send_file Tool

**`packages/core/src/tools/send_file.ts`** (neu):
- Neues Tool in der Tool-Registry: `send_file`
- Parameter: `{ path: string; caption?: string }`
- Validierung: Datei existiert, ist keine Directory, Größe ≤ 100MB Cap
- MIME-Detection aus File-Extension (`detectMimeFromExtension()` mit 20+ Mappings)
- Channel-aware: Wenn kein `channelFileSender` im `ToolCallContext` → `err("Kein sendfähiger Channel")`
- Wenn keine Session → `err("keine aktive Session")`
- `ToolResult` via `ok()` / `err()` Konvention
- `conflictKey()` serializes alle `send_file` Aufrufe (kein Parallel-Send)

**`packages/core/src/tools/types.ts`**:
- `ToolCallContext` um `channelFileSender` erweitert (optionaler Callback)

**`packages/core/src/core/agent.ts`**:
- `RunOptions` um `channelFileSender` erweitert
- `toolContext` reicht `channelFileSender` an Tools durch

**`packages/core/src/tools/registry.ts`**:
- `sendFileTool` zur Standard-Tool-Liste hinzugefügt

**`packages/agent/src/daemon/runtime.ts`**:
- `channelFileSender` Property: löst Session → Source (JID) auf, sendet via Channel-Plugin
- `whatsappSessionToSource` Map (reverse lookup für `whatsappSessions`)
- `submitWhatsAppTurn()` reicht `channelFileSender` an `agent.run()` durch

### 5. Vision-Detection auf Config umgestellt

**`packages/core/src/config.ts`**:
- `ConfigModel` um `supportsVision?: boolean` erweitert

**`packages/agent/src/whatsapp/media.ts`**:
- `isVisionCapableModel()` akzeptiert jetzt `supportsVision?: boolean` in Input
- Config-Flag gewinnt immer: `true` → true, `false` → false (overriding name heuristics)
- Fallback bei `undefined`: bisherige Namens-Heuristik (Anthropic, GPT-4, Gemini, etc.)

**`packages/agent/src/whatsapp/plugin.ts`**:
- `WhatsAppPluginOptions.modelSupportsVision` aus Config durchgereicht
- Beide Vision-Checks im Plugin verwenden jetzt `supportsVision` aus Config

**`harness.config.example.json`**:
- Kimi K2.7 Code und K2.6 mit `"supportsVision": true` markiert

### 6. Test-Härtung

**`packages/agent/tests/whatsapp/media.test.ts`**:
- Kollisions-Test: 100 Namen → 100% unique erwartet (vorher nur >80%)
- Vision-Tests: `supportsVision=true/false` Override + Fallback bei `undefined`

**Neue Tests:**

- `tests/whatsapp/client.test.ts` — MIME→Baileys-Typ Mapping + Sticker-Override + Mock sendFile
- `tests/whatsapp/outbound.test.ts` — Attachments werden gesendet statt geloggt, Reihenfolge, Text-Fallback
- `tests/whatsapp/send_file.test.ts` — Happy path, Datei fehlt, Cap, kein Channel, Sender fail, MIME-Detection

## Welche Dateien

- `packages/agent/src/daemon/types.ts` (erweitert)
- `packages/agent/src/output/capabilities.ts` (erweitert)
- `packages/agent/src/whatsapp/client.ts` (erweitert)
- `packages/agent/src/whatsapp/outbound.ts` (ersetzt)
- `packages/agent/src/whatsapp/plugin.ts` (erweitert)
- `packages/agent/src/whatsapp/index.ts` (erweitert)
- `packages/agent/src/whatsapp/media.ts` (erweitert)
- `packages/agent/src/daemon/runtime.ts` (erweitert)
- `packages/core/src/config.ts` (erweitert)
- `packages/core/src/tools/types.ts` (erweitert)
- `packages/core/src/tools/send_file.ts` (neu)
- `packages/core/src/tools/registry.ts` (erweitert)
- `packages/core/src/core/agent.ts` (erweitert)
- `packages/core/src/lib.ts` (erweitert)
- `harness.config.example.json` (erweitert)

### Tests (neu + erweitert)

- `packages/agent/tests/whatsapp/client.test.ts` (neu, 7 Tests)
- `packages/agent/tests/whatsapp/outbound.test.ts` (neu, 5 Tests)
- `packages/agent/tests/whatsapp/send_file.test.ts` (neu, 13 Tests)
- `packages/agent/tests/whatsapp/media.test.ts` (erweitert: 3 neue Vision + Kollisions-Test hartiert)

## Tests

- 349 agent + 451 core = 800 Tests grün
- Alle bestehenden Tests unverändert grün
- typecheck clean
