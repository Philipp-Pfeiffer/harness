# feat: One-Shot-Cron-Jobs (`once: true`)

## Problem

Cron-Jobs konnten nicht als Einmal-Jobs definiert werden. Ein Job, der z.B. einmalig eine Migration oder einen Setup-Schritt ausführen soll, lief weiter und musste manuell deaktiviert werden.

## Befund

`packages/agent/src/daemon/jobs.ts` und `scheduler.ts` unterstützen keine Einmal-Semantik. Das Frontmatter kennt kein `once`-Feld.

## Was geändert wurde

1. **`CronJob`-Interface** (`jobs.ts`): Neues optionales Feld `once?: boolean`.
2. **Frontmatter-Parser** (`jobs.ts`): Neuer `parseOnce()`-Helper, validiert `true|false`. `parseCronJobFile()` gibt `once` zurück. Doku-Kommentar aktualisiert.
3. **`disableJobFile()`** (`jobs.ts`): Neue exportierte Helper-Funktion, die `enabled: false` in der Job-Datei setzt (oder ergänzt, falls noch nicht vorhanden). Wirft nie — Fehler werden als `{ ok: false, error }` zurückgegeben.
4. **Scheduler** (`scheduler.ts`): Nach einem erfolgreichen Run mit `once: true` wird `disableOneShot()` aufgerufen — stoppt den Cron-Eintrag und schreibt `enabled: false` in die Job-Datei. Bei fehlgeschlagenem Run passiert nichts (Job bleibt aktiv für den nächsten Versuch).

## Dateien

- `packages/agent/src/daemon/jobs.ts` — `once`-Feld, Parser, `disableJobFile()`
- `packages/agent/src/daemon/scheduler.ts` — `disableOneShot()` nach erfolgreichem Run
- `packages/agent/tests/daemon/cronJobs.test.ts` — 4 neue Tests für `once`-Parsing
- `packages/agent/tests/daemon/cronScheduler.test.ts` — 2 neue Tests: Disable nach Erfolg, kein Disable bei Fehlschlag

## Tests

`npx vitest run` — 56 files, 677 tests, alle grün.
`tsc --noEmit` — clean.
