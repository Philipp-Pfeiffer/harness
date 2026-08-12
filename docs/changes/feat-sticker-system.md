# feat: WhatsApp Sticker-System v1 (Inbound-Matching + send_sticker-Tool)

**Changeset:** feat/sticker-system — Branch `feat/sticker-system`

## Problem / Ausgangslage

- Outbound-Sticker-Support existierte bereits (`client.ts: sendFile(..., asSticker?)`, `baileysMessageType()` liefert `"sticker"`), aber es gab keinen Weg für den Agenten, bekannte Sticker zu senden oder eingehende Sticker zu identifizieren.
- Eingehende Sticker wurden bisher nur heruntergeladen und geloggt — der Turn wurde ohne Inhalt verworfen ("media-only, no text").

## Befund

- Pfade: `~/.harness/stickers/` liegt im STATE-Bereich (`$HARNESS_STATE`). `src/config/paths.ts` ist die einzige Pfad-Quelle → neue Pfade dort ergänzt (`stickers`, `stickersIncoming`), inkl. `ensureDirs()`.
- Tool-Capabilities laufen über `RunOptions` → `ToolCallContext` (Muster: `channelFileSender`/`send_file`). `send_sticker` nutzt dasselbe Muster (`channelStickerSender` + `stickerLibraryDir`).
- `send_file` liegt in `packages/core/src/tools/` → `send_sticker.ts` dort angelegt, Registry + `lib.ts` erweitert.
- Das System-Prompt-Addendum (`channelAddendum`) war synchron; Katalog braucht Library-Zugriff → async Variante `channelAddendumAsync(origin, stickerLibraryDir)`; die beiden Daemon-Call-Stellen verwenden sie, die alte synchrone Funktion bleibt für Tests/TUI erhalten.

## Was geändert wurde

### Neu
- `packages/agent/src/stickers/library.ts` — Sticker-Library:
  - `loadStickerIndex(dir)` — index.json lesen; fehlend/kaputt/ungültige Shape → leere Library + `degradedReason`, kein Throw. Einträge ohne `name`/`beschreibung`/`datei`, ohne 64-Hex-Hash-Key oder mit fehlender Datei werden übersprungen.
  - `sha256Hex(buffer)`, `matchOrStoreSticker(dir, sha256, buffer)` — Treffer → Record; Miss → Save nach `incoming/<sha256>.webp` (idempotent), Pfad zurück.
  - `addSticker`, `importStickerFile`, `resolveStickerPath`, `listStickerNames`, `buildStickerCatalog` (Cap 50), `ensureStickerDirs`.
- `packages/core/src/tools/send_sticker.ts` — `sendStickerTool`:
  - Ein Parameter `name` (string). Treffer → Send via `channelStickerSender` mit `asSticker: true` (Datei-Pfad aus index.json).
  - Fehlerfälle: kein Channel-Kontext ("Sticker werden nur auf WhatsApp unterstützt…"), keine Session, unbekannter Name (mit Liste der verfügbaren Namen), leere Library.
  - Description verweist auf den Katalog im System-Prompt und den Library-Ort (`~/.harness/stickers/`).
- Tests: `packages/agent/tests/stickers/library.test.ts`, `packages/agent/tests/whatsapp/plugin_sticker.test.ts`, `packages/core/tests/tools/send_sticker.test.ts`; `channelAddendum.test.ts` + `inbound.test.ts` erweitert.

### Geändert
- `packages/agent/src/whatsapp/plugin.ts` — Sticker-Branch: `fileSha256` aus dem Baileys-Payload (Fallback: Bytes hashen), Match gegen Library, Annotation im Event:
  - Treffer: `[Sticker: <name> — <beschreibung>]`
  - Miss: `[Sticker empfangen: unbekannt, gespeichert unter <pfad>, sha256 <hash>]`
  - Keine automatische Klassifikation.
- `packages/agent/src/whatsapp/inbound.ts` — Sticker-Annotationen fließen in den Turn-Text (debounce/steer kombiniert sie bereits); Test-Mode-Echo zeigt die Annotation; `hasSticker` erkennt Annotationen.
- `packages/agent/src/daemon/channelAddendum.ts` — `channelAddendumAsync`: WhatsApp-Addendum + kompakter Katalog ("name — beschreibung", eine Zeile pro Sticker, Cap 50); leere/kaputte Library → kein Katalog-Block.
- `packages/agent/src/daemon/runtime.ts` — `channelStickerSender` (Session→Plugin-Auflösung, `getFileCapabilities()?.supportsSticker === false` → "Sticker werden nur auf WhatsApp unterstützt.", Send mit `asSticker: true`); beide `agent.run()`-Aufrufe bekommen `channelStickerSender` + `stickerLibraryDir: this.paths.stickers` und `await channelAddendumAsync(...)`.
- `packages/core/src/config/paths.ts` — `stickers`, `stickersIncoming` + `ensureDirs()`.
- `packages/core/src/tools/types.ts` / `core/agent.ts` — `channelStickerSender`, `stickerLibraryDir` in `ToolCallContext` / `RunOptions` (+ Durchreichung in den ToolContext).
- `packages/core/src/tools/registry.ts`, `lib.ts`, `packages/agent/src/whatsapp/index.ts` — Registrierung/Exports.

## Tests

- Neu: Library (index fehlend/kaputt/valide, Match/Miss + incoming-Save, Cap 50, leere Library), Plugin-Sticker (fileSha256-Hit, Miss, Fallback-Hash, kaputter Index), send_sticker (Erfolg, unbekannter Name mit Liste, kein Channel, keine Session, Sender-Fehler), Katalog (Injektion, leer, kaputt, Cap 50).
- `pnpm build` ✓, `pnpm typecheck` ✓.
- `pnpm -r test`: core 549/549 (exkl. pre-existing `exec.test.ts > elevated > id -u` — Umgebung hat kein passwordless sudo; auf `main` identisch rot), agent 590/590 ✓.

## Anmerkungen

- Keine automatische Klassifikation im Code — das bleibt Aufgabe des Agenten (Befüllen der Library via `addSticker`/`importStickerFile` ist als API vorhanden, aber nicht an ein Tool gehängt).
