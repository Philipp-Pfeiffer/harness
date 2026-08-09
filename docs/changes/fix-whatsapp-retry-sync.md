# fix-whatsapp-retry-sync

**Datum:** 2026-08-09

## Symptome

1. **„Warte auf diese Nachricht"** auf WhatsApp Web/Desktop bei Empfängern von Bot-Nachrichten
2. **Gesendete Nachrichten erscheinen nicht** auf dem Primary-Handy der Bot-Nummer

## Befund

Vergleich mit OpenClaw (Baileys rc.9) zeigte zwei Differenzen:

### (a) Retry-Receipts

OpenClaw verwendet in rc.9 einen eigenen In-Memory-Store, um gesendete Nachrichten zu cachen und auf Retry-Receipts zu antworten. Die Annahme war, dass Baileys rc.13 in dieser Hinsicht eine Lücke hat.

**Verifizierungsergebnis rc.13: Baileys rc.13 handhabt Retry-Receipts intern vollständig.**

Belege aus `node_modules/baileys/lib/`:

1. `Defaults/index.js` Z. 73: `enableRecentMessageCache: true` ist Default.
2. `Socket/messages-send.js` Z. 32: Bei `enableRecentMessageCache: true` wird ein `MessageRetryManager` instanziiert (`new MessageRetryManager(logger, maxMsgRetryCount)`).
3. `Socket/messages-send.js` Z. 878-881: `relayMessage()` ruft nach jedem erfolgreichen Send `messageRetryManager.addRecentMessage(destinationJid, msgId, message)` auf — der gesendete Nachrichteninhalt wird automatisch gecacht.
4. `Socket/messages-recv.js` Z. 1040-1159: `sendMessagesAgain()` wird bei eingehenden Retry-Receipts aufgerufen. Es sucht zuerst im `messageRetryManager` (Z. 1050-1057), dann per `getMessage`-Callback (Z. 1060-1061), und sendet die Nachricht via `relayMessage()` erneut (Z. 1154).
5. `Utils/message-retry-manager.js`: Der `MessageRetryManager` verwendet einen LRU-Cache mit 512 Einträgen und 5-Minuten-TTL.

**Kein eigener Message-Store nötig.** Das Symptom „Warte auf diese Nachricht" wird allein durch den fehlenden `getMessage`-Callback verursacht, der von `makeWASocket` benötigt wird, um Nachrichten außerhalb des internen Caches (z. B. nach Neustart) zu finden. Der interne RetryManager deckt den Regelfall ab.

_Hinweis: Ein `getMessage`-Callback, der Nachrichten aus einer persistenten Quelle (z. B. SQLite) nachlädt, könnte in Zukunft ergänzt werden, um Retries auch nach Prozess-Neustarts zu bedienen. Das ist aber nicht Teil dieses Fixes._

### (b) `syncFullHistory: true` und `markOnlineOnConnect: true` (Defaults)

Beide Optionen sind in rc.13 per Default `true` (`Defaults/index.js` Z. 62-63):

- `syncFullHistory: true` erzwingt einen vollen History-Sync beim Connect. Das belastet den Server und kann dazu führen, dass Nachrichten auf dem Primary-Handy nicht korrekt zugestellt werden.
- `markOnlineOnConnect: true` signalisiert dem WhatsApp-Server, dass das Gerät online ist. Das kann die Zustellung auf das Primary-Handy beeinflussen.

OpenClaw setzt beide explizit auf `false`.

## Was wurde geändert

### `packages/agent/src/whatsapp/client.ts`

1. **`makeWASocket`-Options:** `syncFullHistory: false` und `markOnlineOnConnect: false` zum Socket-Konstruktor hinzugefügt (Z. 118-119).

2. **`messages.update`-Debug-Logging:** `sock.ev.on("messages.update", ...)` Handler hinzugefügt, der Receipt-Status-Änderungen (z. B. `READ`, `DELIVERY_ACK`) ins Log schreibt. Macht Retry-Vorgänge beobachtbar.

### `packages/agent/tests/whatsapp/socketOptions.test.ts` (neu)

- Testet, dass `createWhatsAppClient` `syncFullHistory: false` und `markOnlineOnConnect: false` an `makeWASocket` übergibt.
- Zwei Varianten: mit und ohne registrierte Creds.

### Keine Änderungen am Sendepfad

Kein eigener Message-Store implementiert, da rc.13 Retries intern abdeckt (s. o.).

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/agent/src/whatsapp/client.ts` | `syncFullHistory:false`, `markOnlineOnConnect:false`, `messages.update`-Logging |
| `packages/agent/tests/whatsapp/socketOptions.test.ts` | Neu: Socket-Option-Assertions |

## Tests

```
Test Files  8 passed (8)
Tests     101 passed (101)
```

`pnpm build` und `pnpm typecheck` sind clean.
