# feat: Async-Browser-Sessions via verallgemeinertem processSupervisor

## Problem

Das `browser`-Tool war rein synchron: Es blockierte den Agent-Loop bis der
Browser-Sub-Agent fertig war. Für längere Recherchen (30+ Minuten) war das
untauglich — der Turn hing, der User bekam kein Zwischenfeedback, und ein
Daemon-Restart riss die laufende Session ab, ohne sie sauber abzuschließen.

## Befund

- `processSupervisor` verwaltete ausschließlich Kindprozesse (`Session` mit
  handle/pid/Ringbuffer), genutzt von `execBackground`/`execPty`.
- Der System-Event-Bus (`injectSystemEvent` im Daemon) existierte bereits als
  Muster (Mail-Poller, Restart-Ping), konnte aber von Tools nicht angestoßen
  werden.
- `runBrowserSubAgent` war die einzige Runner-Anbindung und immer blockierend.

## Was geändert wurde

### Aufgabe 1 — processSupervisor verallgemeinert
`packages/core/src/tools/processSupervisor.ts` verwaltet jetzt zusätzlich zu
Kindprozessen auch **In-Process-Tasks** (`type Task`): `{ id, type, status
(running/done/error/stopped), summary, artifactPaths, startedAt, stop() }`.
Neue API: `registerTask`, `getTask`, `listTasks`, `countRunningTasks`,
`completeTasksOnRestart` (schließt beim Boot verwaiste Task-Einträge als
`error: daemon restart` ab). Bestehende Prozess-Sessions (`exec`/`execPty`)
bleiben unverändert.

### Aufgabe 2 — browser-Tool um async-Aktionen erweitert
`packages/core/src/tools/browser.ts` hat jetzt einen optionalen `action`-Parameter
(`start` | `status` | `stop`):
- `start(task)` startet die Session im Hintergrund und kehrt sofort mit einer
  Task-ID zurück. Concurrency-Cap: max. 2 laufende Browser-Tasks; darüber
  Tool-Error mit Liste der laufenden IDs.
- `status(id)` liefert Status + Laufzeit (+ letzte Aktion/URL falls greifbar).
- `stop(id)` bricht sauber ab → `stopped`.
- Ohne `action` bleibt das bisherige Sync-Verhalten erhalten (abwärtskompatibel).

### Aufgabe 3 — Completion über Event-Bus
Neuer Runner `packages/core/src/browser/asyncRunner.ts`:
- Bei Abschluss (done/error/stopped/timeout) werden Artefakte unter
  `~/.harness/browser-runs/<id>/` abgelegt (Traces + `result.json`), dann wird
  `injectSystemEvent` mit kurzer Summary (2 Sätze) + Artefakt-Pfaden aufgerufen —
  kein Volltext.
- Timeout pro Task: 30 Minuten → error-Event ("timeout"), kein stilles Hängen.
- Daemon-Restart: `completeTasksOnRestart()` beim Boot markiert laufende Tasks
  als `error: daemon restart` (kein Event nötig).

### Anbindung im Daemon
`packages/agent/src/daemon/runtime.ts` reicht den System-Event-Bus
(`injectSystemEvent`) an das Browser-Tool weiter und ruft beim Start
`completeTasksOnRestart()` auf. Die bestehende Browser-Sub-Agent-Session wird
als Runner angebunden, indem `runBrowserSubAgent` mit einer Task-ID als
sessionId und einem `AbortController` (für stop/timeout) im Hintergrund
gestartet wird — derselbe Sub-Agent, nur nicht mehr blockierend.

## Dateien

- `packages/core/src/tools/processSupervisor.ts` (erweitert)
- `packages/core/src/tools/browser.ts` (async-Aktionen)
- `packages/core/src/browser/asyncRunner.ts` (neu)
- `packages/core/src/tools/registry.ts` (Optionen durchgereicht)
- `packages/core/src/lib.ts` (Task-Typen exportiert)
- `packages/agent/src/daemon/runtime.ts` (Event-Bus + Restart-Sweep)

## Tests

- `packages/core/tests/tools/processSupervisor.test.ts` (7 Tests)
- `packages/core/tests/browser/asyncRunner.test.ts` (8 Tests)
- `packages/core/tests/tools/browser.test.ts` (9 Tests)
