# Fix: execPty Shell Resolution Lazy + Isoliert

## Problem/Symptom

`resolveShell()` in `packages/core/src/tools/execPty.ts` wurde bisher auf Modulebene (Top-Level) ausgeführt:

```ts
const SHELL_PATH = resolveShell();
```

Schlug die Shell-Erkennung fehl, crashte bereits der Import des Moduls. Da `exec.ts` `executeExecPty` importiert und `registry.ts` wiederum `exec.ts` lädt, brachte der Fehler die gesamte Tool-Registry zum Absturz – auch wenn `execPty` nie genutzt wurde.

## Befund

- Top-Level-Aufrufe sind anfällig für Import-Seiteneffekte.
- Der Fehler war nicht auf das eigentliche Tool beschränkt.
- Es gab keinen sauberen Tool-Fehler, sondern einen unbehandelten Throw.

## Was geändert wurde

### `packages/core/src/tools/execPty.ts`

- `resolveShell()` wird nicht mehr beim Import aufgerufen.
- Neue Hilfsfunktion `getShellPath()` löst die Shell erst beim ersten `executeExecPty`-Call auf und cached das Ergebnis (`cachedShellPath`).
- Schlägt die Auflösung zur Laufzeit fehl, wird ein sauberer Tool-Fehler zurückgegeben (`{ isError: true, content: "Failed to resolve shell: ..." }`).
- Registry, `exec`-Tool und alle anderen Tools bleiben unbeeinflusst.

### `packages/core/tests/tools/execPty.lazyShell.test.ts`

Neue Tests:

- Modul-Import wirft nie, auch wenn `node:fs` meldet, dass keine Shell existiert.
- Erster `executeExecPty`-Call löst `existsSync`/`statSync` auf und cached das Ergebnis; zweiter Call verwendet den Cache.
- Auflösungsfehler betrifft nur `execPty` – `executeExecSync` und `loadTools()` funktionieren weiterhin.

## Validierung

- `pnpm -r typecheck` clean
- `pnpm -r test` grün
