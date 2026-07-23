# fix(daemon): restart.lock wurde vom Daemon geerbt und blockierte alle weiteren Restarts

## Problem/Symptom
- Jeder Restart-Versuch schlug fehl mit: `[restart-daemon] Another restart is already in progress. Aborting.`
- Das passierte, obwohl kein anderer Restart lief.

## Befund
- `scripts/restart-daemon.sh` öffnet den flock auf fd 200 (`exec 200>"$LOCK_FILE"`).
- Das finale `exec node packages/agent/dist/index.js daemon run` ersetzt die Shell — der Daemon **erbt fd 200** und hält den Lock damit für seine gesamte Lebensdauer.
- Jeder spätere Restart fand den Lock belegt und brach ab.

## Was geändert wurde

### `scripts/restart-daemon.sh`
- `exec 200>&-` direkt vor dem finalen `exec node ...` — der Lock wird freigegeben, bevor die Shell durch den Daemon ersetzt wird. Die Stop-Phase ist zu diesem Zeitpunkt abgeschlossen, der Lock hat seine Aufgabe (Schutz vor parallelen Restarts) erfüllt.

## Tests
- `bash -n` Syntax-Check clean.
- Manuell verifiziert: Zwei aufeinanderfolgende Restarts über das Skript liefen ohne Lock-Fehler durch; WhatsApp-Session überlebte beide ohne QR-Rescan (siehe `fix-whatsapp-stop-logout.md`).

## Dateien
- `scripts/restart-daemon.sh`
- `docs/changes/fix-restart-lock-fd-leak.md`
