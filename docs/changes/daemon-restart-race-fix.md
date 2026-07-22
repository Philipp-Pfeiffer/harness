# Daemon-Restart Race-Condition Fix

## Problem

Bei jedem dritten Daemon-Restart wurde WhatsApp erneut nach einem QR-Code gefragt.
Ursache: Der alte Daemon-Prozess war noch nicht vollständig beendet, als der neue
Prozess startete. Zwei Harness-Daemons liefen kurzzeitig parallel und griffen
gleichzeitig auf den Baileys-Auth-State im Dateisystem zu. Baileys invalidiert
den gespeicherten Auth-State serverseitig, wenn er von zwei Prozessen gleichzeitig
benutzt wird — das erzwingt ein neues Pairing.

## Befund

- `scripts/restart-daemon.sh` wartete zwar auf das Verschwinden der PID-Datei, aber
  nicht darauf, dass wirklich kein passender Prozess mehr existiert.
- `daemonRestart()` in `packages/agent/src/daemon/commands.ts` wartete nur 300 ms
  zwischen Stop und Start.
- Es gab keinen flock-basierten Schutz gegen parallel ausgeführte Restarts.
- Der Hintergrund-Task, der den Daemon gestartet hatte, lief weiter und konnte bei
  ungünstiger Timing mit einem zweiten Start kollidieren.

## Änderungen

- `scripts/restart-daemon.sh`
  - Verwendet jetzt `flock` auf `$HARNESS_STATE/restart.lock`, damit nie zwei
    Restarts gleichzeitig laufen.
  - Wartet mit `pgrep -f` bis wirklich kein Prozess mehr mit dem Daemon-Command
    läuft (Timeout 30 s).
  - Stoppt alternativ über PID-Datei oder `pgrep`, falls die PID-Datei fehlt.
  - Verwendet `exec` am Ende, damit die Shell durch den Daemon ersetzt wird und
    kein überflüssiger Elternprozess zurückbleibt.
  - Fails hard, wenn nach dem Stop noch Daemon-Prozesse aktiv sind.

- `packages/agent/src/daemon/commands.ts`
  - `daemonRestart()` wartet jetzt bis zu 20 s, bis `pgrep -f` keinen Daemon mehr
    findet, bevor `daemonStart()` aufgerufen wird.
  - `daemonStop()` wartet bis zu 15 s auf sauberes Beenden (vorher 10 s).
  - Zusätzliche 500 ms Pause nach SIGKILL und vor dem Start, damit der Socket
    freigegeben wird.

## Tests

- Manuelle Verifizierung: Nach dem Fix wurde der Daemon mehrfach neu gestartet,
  ohne dass ein neuer QR-Code angefordert wurde.
- Volle Test-Suite bleibt grün (`pnpm -r test`).
- `pnpm typecheck` clean.

## Dateien

- `scripts/restart-daemon.sh`
- `packages/agent/src/daemon/commands.ts`
- `docs/changes/daemon-restart-race-fix.md`
