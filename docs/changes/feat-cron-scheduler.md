# Cron-Scheduler im Daemon

**Datum:** 2026-07-17
**Typ:** Feature

## Problem

Der Daemon hatte keinen Scheduler: zeitgesteuerte Jobs (z. B. nächtliche Reports als Agent-Turn, periodische Aufräumarbeiten wie Metrics-Rotation) waren nicht möglich. `DaemonRuntime.registerHeartbeat` war nur der Mounting-Point; AGENTS.md vermerkte den Scheduler als ausstehend.

## Umsetzung

### Job-Files (`$HARNESS_STATE/jobs/*.md`)

Markdown mit Frontmatter, Body = Prompt (`type: agent`) bzw. Funktionsname (`type: script`):

```
---
name: metrics-rotation
schedule: 0 3 * * *
enabled: true
type: script
jitter: 2h
---
metrics-rotation
```

- `name`, `schedule`, `type` sind Pflicht; `enabled` defaultet auf `true`, `jitter` ist optional (`500ms`/`30s`/`15m`/`2h`/`1d`).
- Parsing in `src/daemon/jobs.ts` (`parseCronJobFile`, `loadCronJobs`): validiert Felder, Cron-Syntax (via `CronPattern` aus croner) und Jitter-Duration. Kaputte Dateien landen als Eintrag in `errors` — `loadCronJobs` wirft nie.

### Scheduler (`src/daemon/scheduler.ts`)

- Library: **croner** (neue Dependency von `@harness/agent`).
- `CronScheduler.start()` lädt alle Jobs, schedult enabled Jobs via `new Cron(schedule, { protect: true }, …)` und watched das Jobs-Verzeichnis (`fs.watch` + 200 ms Debounce) für Reloads. `reload()` reconciled: neue/geänderte Dateien werden (re)scheduliert, entfernte gestoppt.
- **Jitter:** pro Run wird eine zufällige Verzögerung in `[0, jitterMs]` gezogen (`randomJitterMs`) und vor der Ausführung abgewartet.
- **Robustheit:** `fire()` fängt alle Fehler und loggt sie (`job run failed`) — der Daemon stirbt nie an einem Job. Kein Catch-up: Runs, die während Downtime fällig waren, werden übersprungen (croner schedult immer nur den nächsten Zeitpunkt); ein Run, der beim `stop()` noch in seiner Jitter-Verzögerung hängt, wird verworfen. `protect: true` verhindert überlappende Runs desselben Jobs.

### Ausführung

- **`type: agent`** — `DaemonRuntime.runCronAgentJob(job)`: legt über den bestehenden IPC-Pfad (`create-session` mit `origin: "cron"`, dann `submit-turn`) eine **neue Session** an und fährt den Body als ersten Turn. Turn-Queue, Transkript und Metriken kommen dadurch unverändert aus dem bestehenden Codepfad.
- **`type: script`** — Lookup in der internen Registry (`src/daemon/scripts.ts`, `registerScriptJob`/`getScriptJob`). Unbekannte Funktionsnamen sind ein geloggter Job-Fehler. Als Beispiel ist `metrics-rotation` registriert: löscht `turns|tools|system-YYYY-MM-DD.jsonl` älter als `logRetentionDays` (analog zur Log-Rotation).

### Wiring (`src/daemon/runtime.ts`)

- `start()`: Scheduler-Start nach Agent-Init, in try/catch — ein Scheduler-Fehler verhindert den Daemon-Start nicht (Job-Fehler-Log, Daemon läuft weiter).
- `shutdown()`: `scheduler.stop()` direkt nach dem Heartbeat-Stop, laufende Jobs laufen zu Ende, pendende Jitter werden verworfen.
- Neuer Pfad: `paths.jobs` = `$HARNESS_STATE/jobs` in `@harness/core` (`config/paths.ts` + `ensureDirs`).

## Tests

Neu, alle unter `packages/agent/tests/daemon/`:

- `cronJobs.test.ts` (14): Schedule-Parsing (5- und 6-Feld), Defaults, Quoting, ungültige Schedules/Felder/Durations, `loadCronJobs` mit kaputter Datei + fehlendem Verzeichnis.
- `cronScheduler.test.ts` (11): enabled Job feuert, **disabled Job feuert nie**, Agent-Jobs werden mit Body als Prompt an `runAgentJob` geroutet, **Jitter im Range** (`randomJitterMs`-Bounds + Job mit `jitter: 1s` feuert innerhalb Schedule+Jitter), fehlerwerfender Job wird geloggt und der Scheduler feuert weiter, unbekannte Script-Funktion überlebt der Scheduler, Reload nimmt neue/geänderte Dateien auf, fehlendes Jobs-Verzeichnis ist kein Fehler.
- `cronAgentJob.test.ts` (2): **Agent-Job erzeugt Session mit origin `cron`** und Body als erstem Turn (echte `DaemonRuntime` mit temp `HARNESS_HOME`/`HARNESS_STATE` und injiziertem Fake-Agent — gleiches Muster wie `turnQueueConcurrency.test.ts`); Fehlerfall ohne initialisierten Agent.

Dazu erweitert: `packages/core/tests/config/paths.test.ts` (jobs-Pfad).

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/core/src/config/paths.ts` | `paths.jobs` (`$state/jobs`) + `ensureDirs` |
| `packages/agent/src/daemon/jobs.ts` | Neu — Job-File-Parsing, Validierung, `loadCronJobs` |
| `packages/agent/src/daemon/scheduler.ts` | Neu — `CronScheduler` (croner, Watch/Reload, Jitter, Fehlerisolierung) |
| `packages/agent/src/daemon/scripts.ts` | Neu — Script-Registry + Beispiel `metrics-rotation` |
| `packages/agent/src/daemon/runtime.ts` | Scheduler-Wiring in `start()`/`shutdown()`, `runCronAgentJob` |
| `packages/agent/package.json` | Dependency `croner` |
| `packages/agent/tests/daemon/cron{Jobs,Scheduler,AgentJob}.test.ts` | Neu — 27 Tests |
| `packages/core/tests/config/paths.test.ts` | jobs-Pfad mit abgedeckt |
| `AGENTS.md` | Daemon-Doku: Cron-Scheduler statt "kommt später" |
