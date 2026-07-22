# fix(whatsapp): Session-Resume, Typing-Indicator und Dateisendung

## Problem/Symptom
- Nach jedem Daemon-Neustart wurde für denselben WhatsApp-Chat eine **neue Session** angelegt. Die laufende Konversation ging nicht verloren, aber die bisherige History musste jedes Mal neu als Kontext mitgeschickt werden → hoher Token-Verbrauch.
- `send_file` und das Senden von Attachments (z. B. gerenderte PNGs für Tabellen) schlugen mit `Cannot read properties of undefined (reading 'toString')` fehl.
- Voice-Nachrichten wurden nur als Media-Annotation an den Agenten übergeben, nicht als Transkript.
- Sticker und leere Media-Events lösten sinnlose Agent-Turns aus.
- Es gab keinen visuellen Hinweis, wenn der Agent gerade arbeitet.

## Befund
- `resolveWhatsAppSession` in `runtime.ts` legte bei jedem Restart eine neue Session an, weil die In-Memory-Map leer war und keine Persistenz-Prüfung existierte.
- `client.sendFile()` übergab Medien im falschen Format (`{ document: { mimetype, data: buffer } }`). Baileys erwartet `{ document: buffer }` mit `mimetype`/`fileName` auf Top-Level oder `{ image: buffer, caption }` etc.
- Die Inbound-Pipeline hat Voice-Transkripte nicht als Text in den Turn eingespeist.
- Sticker-Events wurden wie normale Media-Events behandelt.
- `sendTyping` war zwar im Client-Interface, aber nicht von der Inbound-Pipeline aufgerufen.

## Was geändert wurde

### `packages/agent/src/daemon/runtime.ts`
- `resolveWhatsAppSession(source)` sucht jetzt zuerst im Speicher, dann im `sessions.json`-Index nach `title === "WhatsApp: <source>"`.
- Wenn die letzte Aktivität <8h zurückliegt, wird die bestehende Session resumed (inkl. `turnsToMessages`).
- Wenn die Session >8h inaktiv ist oder nicht existiert, wird eine **neue** Session erstellt und der Chat bekommt die Notifikation:  
  `[Neue Session gestartet — vorheriger Kontext wurde zurückgesetzt.]`
- `channelFileSender` übergibt Dateien an das WhatsApp-Plugin.

### `packages/agent/src/whatsapp/client.ts`
- `sendFile` sendet Medien jetzt im korrekten Baileys-Format:
  - `image`/`audio`/`video`/`sticker`: `{ [type]: buffer, caption? }`
  - `document`: `{ document: buffer, mimetype, fileName }`
- `sendTyping`, `markAsRead` und `resolveLidToPn` implementiert.
- QR-Code wird als Terminal-Art und PNG in `~/Downloads/whatsapp-qr.png` ausgegeben.

### `packages/agent/src/whatsapp/plugin.ts`
- LID-JIDs werden zu phone-number-JIDs aufgelöst, bevor Whitelist/Session-Routing greift.
- Typing-Indicator wird direkt nach dem Whitelist-Check gestartet.
- Voice-Nachrichten (`ptt=true`) werden transkribiert und das Transkript als User-Text in den Turn eingefügt (ohne zusätzliche Media-Annotation).
- Sticker werden nur gespeichert und geloggt, lösen aber keinen Agent-Turn aus.
- Nach erfolgreicher Verarbeitung wird die Nachricht als gelesen markiert.

### `packages/agent/src/whatsapp/inbound.ts`
- Debounce, 8h-Compaction-Hook, Abort-and-Restart-Logik mit Max-2-Restarts und Steer-Injection über Mailbox.

### `packages/agent/src/whatsapp/media.ts`
- Voice-Transkription über AssemblyAI liefert nur noch den Text zurück.
- `generateMediaFilename` prüft jetzt, ob der Zielpfad bereits existiert, und generiert bei Kollision einen neuen Namen (max. 10 Versuche, danach 16-Byte-Fallback).

### `packages/agent/src/output/capabilities.ts`
- WhatsApp-Capabilities `maxMonospaceWidth` und `maxTableColumns` auf `0` gesetzt, damit Tabellen **immer** als PNG-Bild gerendert werden.

### `packages/agent/src/whatsapp/outbound.ts`
- Attachments werden ohne `caption` versandt (keine "table.png"-Unterschrift mehr).

## Tests
- `pnpm -r typecheck` clean.
- `pnpm -r test` vollständig grün (350 Tests in packages/agent).
- Neue/existierende Tests:
  - `tests/whatsapp/send_file.test.ts`
  - `tests/whatsapp/client.test.ts`
  - `tests/whatsapp/outbound.test.ts`
  - `tests/whatsapp/media.test.ts`
  - `tests/output/pipeline.test.ts`

## Dateien
- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/src/whatsapp/client.ts`
- `packages/agent/src/whatsapp/plugin.ts`
- `packages/agent/src/whatsapp/inbound.ts`
- `packages/agent/src/whatsapp/media.ts`
- `packages/agent/src/whatsapp/outbound.ts`
- `packages/agent/src/whatsapp/limits.ts`
- `packages/agent/src/output/capabilities.ts`
- `packages/agent/tests/whatsapp/*.test.ts`
- `packages/agent/tests/output/snapshots/whatsapp-mixed.snap.json`
- `docs/changes/fix-whatsapp-session-resume-sendfile.md`
