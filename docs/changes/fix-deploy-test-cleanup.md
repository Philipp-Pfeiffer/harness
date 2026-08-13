# fix-deploy-test-cleanup

## Problem/Symptom

Flaky Test-Rot blockiert `/deploy` (safe-deploy.sh): Temp-Verzeichnis-Cleanup
in `afterEach` nutzte `rmdirSync(dir, { recursive: true })` aus `node:fs`.
Diese API ist deprecated und nicht fehlertolerant — bei nicht-leerem oder
nicht mehr existierendem Verzeichnis kann sie werfen, sodass Tests sporadisch
fehlschlagen.

## Befund

`packages/agent/tests/daemon/cronAgentJob.test.ts` nutzt bereits korrektes
`rm` aus `node:fs/promises`. Verbleibende `rmdirSync`-Stellen:

- `packages/agent/tests/cli/migrateHome.test.ts` (3×)
- `packages/agent/tests/core/session.test.ts` (1×)
- `packages/agent/tests/core/session-resume.test.ts` (2×)
- `packages/core/tests/config/paths.test.ts` (1×)
- `packages/core/tests/skills/skills.test.ts` (1×)

Keine geteilte Fixture — jede Datei hat eigenes `afterEach`.

## Änderung

`rmdirSync(dir, { recursive: true })` → `rmSync(dir, { recursive: true, force: true })`
in allen fünf Testdateien (Import angepasst). Gleiches Idiom, gleiche Semantik,
rekursiv + fehlertolerant. Kein Produkt-Code angefasst.

## Dateien

- `packages/agent/tests/cli/migrateHome.test.ts`
- `packages/agent/tests/core/session.test.ts`
- `packages/agent/tests/core/session-resume.test.ts`
- `packages/core/tests/config/paths.test.ts`
- `packages/core/tests/skills/skills.test.ts`

## Tests

- `cronAgentJob.test.ts`: 3 separate Runs grün (je 7 Tests).
- Betroffene Dateien grün: agent 70 Tests (session, session-resume, migrateHome),
  core 57 Tests (paths, skills).
- `pnpm -r typecheck` grün (nach `@harness/core`-Build, `dist/` ist gitignored).
