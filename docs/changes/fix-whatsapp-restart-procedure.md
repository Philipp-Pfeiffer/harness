# fix(whatsapp): Graceful-Daemon-Restart verhindert erzwungenen QR-Rescan

## Problem/Symptom
- Nach mehreren schnellen Daemon-Neustarts mit `kill -9` meldete Baileys `WhatsApp disconnected (reason: 401)` und verlangte einen neuen QR-Code-Scan.
- Der Auth-State unter `~/.harness/whatsapp/auth/` wurde auf WhatsApp-Serverseite ungültig, weil die Verbindung hart unterbrochen wurde.

## Befund
- `kill -9` beendet den Prozess sofort, ohne den graceful-shutdown Handler von `runtime.ts` laufen zu lassen.
- Baileys schreibt den Auth-State beim sauberen Disconnect; bei hartem Kill bleibt der State inkonsistent.
- Nach mehreren harten Restarts wird der gespeicherte State von WhatsApp abgelehnt.

## Was geändert wurde

### `scripts/restart-daemon.sh` (neu)
- Stoppt den Daemon per `SIGTERM` und wartet bis zu 15 Sekunden auf sauberes Beenden.
- Erst danach fällt auf `SIGKILL` zurück.
- Startet den Daemon anschließend neu mit den aus `~/.bashrc` geladenen Env-Variablen.

### `docs/changes/fix-whatsapp-restart-procedure.md` (diese Datei)
- Dokumentation der Prozedur und der Warnung.

## Empfohlene Vorgehensweise

Für jeden zukünftigen Daemon-Restart:

```bash
./scripts/restart-daemon.sh
```

Niemals `kill -9` direkt auf den Daemon-Prozess anwenden, solange WhatsApp verbunden ist.

## Tests
- Keine neuen Unit-Tests; das Skript wurde manuell auf Syntaxkorrektheit geprüft (`bash -n`).

## Dateien
- `scripts/restart-daemon.sh`
- `docs/changes/fix-whatsapp-restart-procedure.md`
