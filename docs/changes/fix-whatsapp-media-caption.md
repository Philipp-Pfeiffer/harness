# fix: WhatsApp-Media-Captions gehen nicht verloren

## Problem/Symptom

Bild mit Begleittext (Caption) via WhatsApp → beim Modell kam nur das Bild
(Media-Annotation) an, der Begleittext fehlte im Turn-Text.

## Befund

In `packages/agent/src/whatsapp/plugin.ts` (parseBaileysMessage) wurden die
Caption-Felder der Baileys-Media-Messages nie gelesen — nur `conversation` /
`extendedTextMessage.text` wurden als Text übernommen. `imageMessage`,
`videoMessage` und `documentMessage` haben in Baileys je ein `caption`-Feld,
das unbeachtet blieb.

## Geändert

- **`packages/agent/src/whatsapp/plugin.ts`**:
  - Image: `message.imageMessage.caption` → Turn-Text (falls vorhanden).
  - Video: `message.videoMessage.caption` → Turn-Text.
  - Document: `message.documentMessage.caption` → Turn-Text.
  - Keine Caption → Verhalten unverändert (Text bleibt leer, Media-Annotationen
    wie bisher).
  - Sticker-Pfad unberührt (eigene Annotation, keine Caption-Logik).

Die Caption landet über das bestehende `text`-Feld des Events im Turn
(`flushDebounced` in `inbound.ts`); Media-Annotationen („Bild angehängt: …")
kommen weiterhin aus `processMediaForTurn`.

## Dateien

- `packages/agent/src/whatsapp/plugin.ts`
- Test (neu): `packages/agent/tests/whatsapp/plugin_caption.test.ts`

## Tests

- Neu `plugin_caption.test.ts`: 5 — Image/Video/Document mit Caption → Caption
  im Turn-Text; Image ohne Caption → Text leer, Annotationen unverändert;
  Sticker unberührt.
- Agent-Suite: 611 grün (vorher 606). Core: weiterhin nur der bekannte
  `exec.test.ts` „elevated > id -u" rot (Umgebungsproblem, vorbelastet).
