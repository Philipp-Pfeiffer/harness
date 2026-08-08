# Change: Daemon Self-Deploy / Self-Restart (`/deploy`, `/restart`)

## Übersicht

Der Daemon kann sich über WhatsApp-Commands selbst neu starten und eine
Branche nach `main` deployen. Der Neustart läuft **deferred** (nach Ende des
aktuellen Turns) und wird von systemd ausgelöst — kein externer Kill, kein
`systemd-run`.

## Symptom / Motivation

- Daemon läuft als `systemd --user` Unit (`harness-daemon`, `Restart=on-failure`,
  `RestartSec=5`, `KillSignal=SIGTERM`). Exit-Code `0` → kein Neustart,
  Exit-Code `!= 0` → systemd startet neu.
- Ein Hard-Kill oder zwei parallele Daemons korrumpieren den Baileys-Auth-State
  → QR-Neu-Pairing (siehe `scripts/restart-daemon.sh`). Deshalb: niemals
  `kill -9` auf den eigenen Prozess, niemals einen zweiten Daemon starten.

## Befund / Design

### Deferred Restart (Anforderung 1)

`DaemonRuntime.requestRestartAfterTurn(grund, replyTarget?, gitHead?)`:

1. Schreibt **sofort** die Marker-Datei `$HARNESS_STATE/pending-restart.json`
   (`{ timestamp, reason, replyTarget, gitHead }`) — der Shutdown-Pfad darf
   diese Absicht nicht verlieren, wenn er mittendrin fehlschlägt.
2. Setzt `pendingRestartReason`.
3. Läuft gerade ein Turn (`turnActive`), passiert nichts weiter — nach
   Turn-Ende + Antwort-Versand triggert `performPendingRestartIfNeeded()` den
   Shutdown.
4. Läuft kein Turn, wird `shutdownWithExit("self-restart", 1)` via
   `setImmediate` geplant, damit die Bestätigungsantwort (Socket-Write /
   WhatsApp-Outbound) vor dem Gateway-Stopp flushen kann.

`shutdownWithExit(signal, exitCode)` ist der Refactored-`shutdown()`-Pfad
(dieselbe Sequenz: Heartbeat stoppen, Cron stoppen, Gateways stoppen → Baileys
`stop()` ohne serverseitiges `logout()`, IPC-Server stoppen, Sessions suspenden,
Memory-Service, PID-File, Metrics) — mit dem Unterschied, dass `process.exit`
den übergebenen Code nutzt. `shutdown()` bleibt `shutdownWithExit(signal, 0)`.

### Restart-Marker + Post-Restart-Ping (Anforderung 2)

- Vor dem Exit: Marker-Datei (atomar via Temp+rename).
- Beim Daemon-Boot (`start()`, nach `initGateways`): falls Marker existiert →
  `sendRestartPing()` schickt über den WhatsApp-`ChannelPlugin.sendMessage`-Pfad
  "Back online. Reason: <reason>. HEAD: <gitHead>" an `replyTarget`; danach wird
  der Marker konsumiert (gelöscht). Fehler beim Senden → warn-Log, Marker wird
  trotzdem gelöscht (kein Retry-Sturm).

### `/deploy <branch>` (Anforderung 3)

Ablauf in `handleDeployCommand`:

1. Guard: `branch` darf nicht `main`/`origin/main`/`HEAD` sein.
2. Guard: nur **ein** Self-Modify in Flight (`selfModifyInFlight`-Lock).
3. `runDeploy(repoDir, branch, log, {timeoutMs})` — nutzt
   `scripts/safe-deploy.sh <branch>` **falls vorhanden**, sonst Inline:
   (a) lokaler Merge/FF von `<branch>` nach `main` (`git merge --no-edit`, kein
   Fetch — Branches müssen lokal existieren), (b) `pnpm install && pnpm build &&
   pnpm typecheck && pnpm --filter @harness/agent test` (Streaming in Daemon-Log,
   Timeout 10 min), (c) bei jedem Fehlschlag `git reset --hard <vorheriger HEAD>` +
   `git clean -fdq`, Fehler per WhatsApp, **kein** Restart, (d) bei Erfolg:
   Antwort "Deploy prepared, restarting…", Marker (`reason="deploy <branch>"`,
   `gitHead` = neuer HEAD), `requestRestartAfterTurn`.
4. Läuft gerade ein Turn: Antwort "...(after the current turn finishes)".

### `/restart` (Anforderung 3b)

Gleicher Deferred-Restart-Pfad, ohne Git/Build:

- Kein Turn: "Restarting — back in a few seconds." + Marker + `requestRestartAfterTurn`.
- Turn läuft: "Restart scheduled — will restart after the current turn finishes." + Flag.
- Nach Hochfahren: normaler Post-Restart-Ping → Session bekommt Bestätigung → Pause → "Back online.".

### Guards (Anforderung 4)

- `/deploy` während laufendem Turn: **erlaubt** (Turn-Queue wird nicht gestört;
  `requestRestartAfterTurn` prüft `turnActive` erst beim Schreiben des Markers).
- Parallele `/deploy`: Lock (`selfModifyInFlight`) → zweite Antwort "already in progress".
- `/deploy main`: abgelehnt (Branch-Pflicht).
- Timeout für Build/Test: `DEPLOY_TIMEOUT_MS = 10 min`, sauberer Abbruch
  (SIGTERM → 5s später SIGKILL auf den Kindprozess, Exit-Code 124 → Rollback).

## Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `packages/agent/src/daemon/restartMarker.ts` | **Neu** — Marker schreiben/konsumieren (atomar, korrupt-tolerant) |
| `packages/agent/src/daemon/deploy.ts` | **Neu** — `runDeploy` (safe-deploy.sh oder Inline), `SAFE_DEPLOY_EXIT`, `readRepoInfo`, `runProcess` (Streaming + Timeout) |
| `packages/agent/src/daemon/selfModify.ts` | **Neu** — `HARNESS_REPO_DIR`, `currentGitHead`, `readPendingRestart`, `scheduleRestart`, `sendRestartPing` |
| `packages/agent/src/daemon/runtime.ts` | `shutdownWithExit`-Refactor, `requestRestartAfterTurn`, `performPendingRestartIfNeeded`, Boot-Ping, `turnActive`-Tracking, `/deploy` + `/restart` in `handleChannelSlashCommand`, `/help` erweitert |
| `packages/agent/tests/daemon/restartMarker.test.ts` | **Neu** — 4 Tests |
| `packages/agent/tests/daemon/selfModify.test.ts` | **Neu** — 11 Tests |
| `docs/changes/feat-self-deploy.md` | **Neu** — dieser Change-Report |

## Tests

- `restartMarker.test.ts` — Round-Trip, kein Marker, korrupte Marker, fehlende Felder.
- `selfModify.test.ts` — Deferred Restart (Turn läuft → kein Exit; nach Turn →
  Shutdown exit 1 + Marker), Boot-Ping (Marker → Outbound-Mock + Marker gelöscht;
  ohne Marker → nichts), `/deploy` (main-Ablehnung, ohne Argument → null,
  Build-Fehlschlag → Fehlerantwort + kein Exit + kein Marker, Erfolg → Marker +
  `requestRestartAfterTurn`, Doppelaufruf → Lock), `/restart` (Marker + kein
  Build-Step, deferred während Turn).
- Bestandssuite: 437 Tests grün (vorher ~426; `logs.test.ts` lief ohne isolated
  Timeout-Flake durch).

## Schnittstellen-Doku für das Folgepaket (`safe-deploy.sh`)

**Contract von `scripts/safe-deploy.sh <branch>`** (wenn das Script existiert,
delegiert `runDeploy` dorthin; sonst Inline-Fallback mit identischem Verhalten):

- Argumente: genau eins — der Branch, der nach `main` gemergt werden soll.
- Exit-Codes:
  - `0` — merge/FF ok, Build+Typecheck+Test grün, `main` auf neuem HEAD, Restart bereit.
  - `1` — Konflikt/Validierungsfehler, `main` unverändert (nichts zu rollbacken).
  - `2` — Merge ok, aber Build/Test fehlgeschlagen → `main` auf vorherigen HEAD zurückgesetzt.
  - jeder andere Exit-Code → wird als `BUILD_FAILED` behandelt (Rollback erwartet).
- Das Script macht die Git-Arbeit + Build/Test; der Daemon besitzt den
  Restart-Marker, das `/deploy`-Lock, die "Deploy prepared, restarting…"-Antwort
  und den eigentlichen Restart. Working-Dir ist der Repo-Root, Output wird ins
  Daemon-Log gestreamt. Das Script darf niemals den laufenden Daemon-Prozess
  oder `$HARNESS_STATE` anfassen.

## Non-Goals

- Kein Health-Watchdog, kein Auto-Rollback (kommt separat).
- Keine Änderung an der systemd-Unit.
- Kein Runbook/Skill, keine TUI-Änderungen.
- Kein externer Kill / `systemd-run` für den Restart — ausschließlich
  `process.exit(1)` über den sauberen Shutdown-Pfad.
