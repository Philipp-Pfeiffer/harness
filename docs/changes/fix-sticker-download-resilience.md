# fix: Robuster Sticker-Media-Download + Registrierungs-Doku statt Memory-Notiz

**Changeset:** fix/sticker-download-resilience — Branch `feat/sticker-system`

## Problem / Symptom

- Produktions-Report: Von 7 in schneller Folge gesendeten Stickern kamen nur 1 beim Agenten an. Die anderen 5 schlugen im Baileys-Download mit `Sticker download failed: fetch failed` fehl (14:58:13–14:58:42).
- Der Agent wusste das `index.json`-Schema (sha256 → `{name, beschreibung, datei}`) nicht und hat es per Quellcode-Reverse-Engineering + Memory-Notiz herausgefunden — kein sauberer Workflow.

## Befund

1. `downloadContentFromMessage` nutzt ohne `host`-Option Baileys' statisches `DEF_MEDIA_HOST` (`mmg.whatsapp.net`). Baileys bezieht beim Connect eine region-optimierte `media_conn` (`sock.getMediaHost()`, aus `refreshMediaConn()`), die für eingehende Downloads ungenutzt blieb. Bei kurzen, schnellen Downloads (Sticker) können die generischen Hosts mit `fetch failed` (Netzwerk-Timeout) ausfallen.
2. Es gab keinerlei Retry bei transienten Netzwerkfehlern — ein einzelner `fetch failed` warf sofort und der Sticker wurde verworfen (nur `warn`-Log).
3. Das Registrierungs-Schema stand nur im Code (`packages/agent/src/stickers/library.ts` + Tool-Description "index.json + webp files"), nicht in dem, was der Agent im Kontext sieht (System-Prompt-Addendum).

## Was geändert wurde

### Neu
- `packages/agent/src/whatsapp/mediaDownload.ts` — `downloadMediaContent()`: host-Priorität Socket-media_conn → Host aus Message-URL → Default, max. 3 Hosts; pro Host max. 2 Versuche mit Backoff (250ms/500ms) nur bei transienten Fehlern (`fetch failed`, `ECONNRESET`, Timeouts, "socket hang up"); nicht-retrybare Fehler (HTTP 4xx, fehlende URL) failen sofort. Exportierte Hilfen `buildMediaHostPlan()`, `isRetryableDownloadError()`.
- `packages/agent/src/util/async.ts` — `sleep()`.

### Geändert
- `packages/agent/src/whatsapp/client.ts` — `WhatsAppClient` um `getMediaHost()` / `refreshMediaConn()` erweitert (Delegation an den Baileys-Socket); Mock-Client kompatibel gehalten.
- `packages/agent/src/whatsapp/plugin.ts` — alle 5 Download-Call-Sites (image/video/audio/document/sticker) auf `downloadMediaContent` umgestellt (Socket als `MediaHostSource` durchgereicht); `isJidGroup`-Workaround: Gruppen-Nachrichten über `key.participant` erkannt (Baileys-`isJidGroup()` matcht exakt `@g.us` und verfehlt LID-Gruppen-JIDs).
- `packages/agent/src/daemon/channelAddendum.ts` — neuer `STICKER_REGISTRATION_GUIDE`-Block nach dem Katalog: Schema `{ "<sha256-hex>": { name, beschreibung, datei } }`, Workflow (Datei kopieren → Hash berechnen → Eintrag → Datei muss existieren), Hinweis auf automatische Katalog-Aktualisierung. Wird auch bei leerer Library injiziert (erstes Mal: kein Ratespiel).
- `packages/core/src/tools/send_sticker.ts` — Tool-Description um das exakte index.json-Schema + Registrierungs-Schritte ergänzt (statt "index.json + webp files").

## Tests

- Neu `tests/whatsapp/mediaDownload.test.ts` (10): Host-Priorität (Socket > URL > Default), `refreshMediaConn`-Fallback bei leerem Socket-Host, Retry bei `fetch failed` (2 Versuche), Fail-fast bei 403, Fehler bei fehlender URL/directPath, `isRetryableDownloadError`-Klassifikation.
- `channelAddendum.test.ts` angepasst: Guide-Präsenz bei gefüllter/leerer Library; Catalog-Zeilen-Zählung auf Katalog-Sektion begrenzt.
- `packages/agent`: 600/600 Tests grün; `packages/core`: nur vorbestehender Umgebungs-Fail `exec elevated` (kein passwordless sudo) — unabhängig von diesem Changeset.
- Vorab unabhängig auf `main` verifiziert: `pipeline`-Snapshot (fehlender Trailing-Newline) und `obscura`-Timeout (5s-Grenze) sind vorbestehend und nicht durch diesen Changeset verursacht.

## Deployment-Hinweis

- Nach Deploy greifen: Socket-Host-Priorität + Retry wirken ab sofort auf alle eingehenden Medien (Bilder/Videos/Audio/Dokumente/Sticker).
- Der Registrierungs-Guide erscheint im WhatsApp-System-Prompt-Addendum; der alte Memory-Eintrag kann entfernt werden.
