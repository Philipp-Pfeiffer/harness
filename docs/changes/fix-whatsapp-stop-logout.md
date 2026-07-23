# fix(whatsapp): Kein QR-Rescan mehr nach Daemon-Restart

## Problem/Symptom
- Nach **jedem** Daemon-Neustart (auch sauberem, per SIGTERM) musste der WhatsApp-QR-Code neu gescannt werden.
- Damit waren die früheren Fixes (graceful restart, Race-Condition-Fix) wirkungslos: Selbst ein textbook-mäßig sauberer Shutdown erzwang ein neues Pairing.

## Befund
- `client.stop()` in `packages/agent/src/whatsapp/client.ts` rief `sock.logout()` auf.
- `logout()` ist in Baileys kein „Verbindung schließen", sondern ein **serverseitiges Unlink**: Das Gerät wird aus der Liste der verknüpften Geräte entfernt und der Auth-State unter `~/.harness/whatsapp/auth/` wird serverseitig invalidiert.
- Die Shutdown-Kette `runtime.shutdown()` → `gateway.stop()` → `plugin.stop()` → `client.stop()` führte also bei jedem geplanten Restart zu einem Unlink → QR-Rescan beim nächsten Start.
- Zweiter Befund: Bei `connection === "close"` mit Status 401 (`DisconnectReason.loggedOut`) wurde trotzdem der Reconnect-Backoff gestartet — ein sinnloser Reconnect-Loop mit toten Credentials.

## Was geändert wurde

### `packages/agent/src/whatsapp/client.ts`
- `stop()` schließt die Verbindung jetzt nur noch per `sock.end(undefined)` — **kein** serverseitiges Logout mehr. Der Auth-State bleibt gültig, der nächste Start resumed die Session ohne QR-Scan.
- Neues explizites `logout()` im `WhatsAppClient`-Interface für den Fall, dass ein echtes Unlink gewünscht ist (invalidiert die Session serverseitig, erfordert Re-Pairing). Mock-Client entsprechend ergänzt.
- Bei `close` mit `DisconnectReason.loggedOut` (401) wird **nicht** mehr reconnectet; stattdessen wird klar geloggt, dass ein Re-Pairing nötig ist.

## Tests
- `pnpm -r typecheck` clean.
- `pnpm -r test` vollständig grün (350 Tests in packages/agent).
- Bestehende Tests hingen nicht am alten `stop()`-Logout-Verhalten; kein Test musste angepasst werden.

## Hinweis
Nach dem Deploy dieses Fixes ist **ein letzter** QR-Scan nötig (falls die Session bereits invalidiert wurde). Danach überlebt die Session beliebige Daemon-Restarts.

## Dateien
- `packages/agent/src/whatsapp/client.ts`
- `docs/changes/fix-whatsapp-stop-logout.md`
