# fix: Tools Territory — atomic_write Kollisionsschutz, path_util Dedup, 64KB-Centralisierung

## Problem/Symptom

1. **1.4 atomic_write.ts:** Temp-Dateiname war fix (`${path}.harness.tmp`) — parallele Schreibvorgänge über Sessions konnten kollidieren.
2. **2.1 Duplizierte Helper:** `expandTilde`, `checkNoFly`, `resolveCwd` waren in `exec.ts`, `execBackground.ts` und `execPty.ts` jeweils identisch dupliziert, obwohl `path_util.ts` bereits existierte.
3. **2.2 Magic Numbers:** 64KB-Output-Limits waren als `64 * 1024` an mehreren Stellen separat definiert statt zentral in `limits.ts`.

## Befund

### 1.4 atomic_write
- `atomic_write.ts:17`: `const tmpPath = \`${absolutePath}.harness.tmp\`;` — kein eindeutiger Suffix.

### 2.1 Duplizierte Helper
- `exec.ts:92-180`: `EXEC_NO_FLY_PATTERNS` (Definition + Export), `expandTilde`, `checkNoFly`, `resolveCwd`.
- `execBackground.ts:12-46`: identische lokale Kopien von `expandTilde`, `checkNoFly`, `resolveCwd`; importierte `EXEC_NO_FLY_PATTERNS` aus `exec.ts`.
- `execPty.ts:48-82`: identische lokale Kopien von `expandTilde`, `checkNoFly`, `resolveCwd`; importierte `EXEC_NO_FLY_PATTERNS` aus `exec.ts`.
- `path_util.ts`: hatte bereits `expandTilde` und `resolveExpandedPath`, aber nicht `checkNoFly`, `resolveCwd` oder `EXEC_NO_FLY_PATTERNS`.

### 2.2 Magic Numbers
- `readFile.ts:16`: `const MAX_EXTRACTED_BYTES = 64 * 1024;`
- `readFile.ts:34`: `const BINARY_SAMPLE_SIZE = 64 * 1024;`
- `process.ts:245`: `processSupervisor.pollOutput(sessionId, 64 * 1024)`
- `limits.ts`: hatte nur `SYNC_OUTPUT_CAP` und `BG_OUTPUT_CAP`.

## Was geändert wurde

### 1.4 atomic_write — eindeutiger Tmp-Name
- **Datei:** `packages/core/src/tools/atomic_write.ts`
- Tmp-Dateiname um PID + zufälligen Hex-Suffix erweitert: `${path}.harness.${process.pid}.${randomUUID().slice(0,8)}.tmp`
- Import von `randomUUID` aus `node:crypto` hinzugefügt.

### 2.1 Helper in path_util.ts zusammengezogen
- **Datei:** `packages/core/src/tools/path_util.ts`
  - `EXEC_NO_FLY_PATTERNS` (aus exec.ts verschoben)
  - `checkNoFly` (aus exec.ts/execBackground.ts/execPty.ts konsolidiert)
  - `resolveCwd` (aus exec.ts/execBackground.ts/execPty.ts konsolidiert, statische `import { stat }` statt dynamischem `import("node:fs/promises")`)
- **Datei:** `packages/core/src/tools/exec.ts`
  - `EXEC_NO_FLY_PATTERNS`-Definition entfernt, Re-Export aus `path_util.ts` (Tests importieren weiterhin aus `exec.ts`)
  - Lokale `expandTilde`, `checkNoFly`, `resolveCwd` entfernt; durch Import aus `path_util.ts` ersetzt
  - Nicht mehr benötigte Imports entfernt (`resolve`, `homedir`, `cwd`)
- **Datei:** `packages/core/src/tools/execBackground.ts`
  - Lokale `expandTilde`, `checkNoFly`, `resolveCwd` entfernt; durch Import aus `path_util.ts` ersetzt
  - `EXEC_NO_FLY_PATTERNS`-Import entfernt (nicht mehr direkt genutzt)
  - Nicht mehr benötigte Imports entfernt (`resolve`, `homedir`, `cwd`)
- **Datei:** `packages/core/src/tools/execPty.ts`
  - Lokale `expandTilde`, `checkNoFly`, `resolveCwd` entfernt; durch Import aus `path_util.ts` ersetzt
  - `EXEC_NO_FLY_PATTERNS`-Import entfernt (nicht mehr direkt genutzt)
  - Nicht mehr benötigte Imports entfernt (`resolve`, `homedir`, `cwd`)

### 2.2 64KB-Caps in limits.ts zentralisiert
- **Datei:** `packages/core/src/tools/limits.ts`
  - `TEXT_EXTRACT_CAP = 64 * 1024` (für readFile)
  - `BINARY_SCAN_SAMPLE_SIZE = 64 * 1024` (für readFile)
- **Datei:** `packages/core/src/tools/readFile.ts`
  - `MAX_EXTRACTED_BYTES` und `BINARY_SAMPLE_SIZE` nun Aliase auf limits-Konstanten
- **Datei:** `packages/core/src/tools/process.ts`
  - `64 * 1024` in `handleWait` durch `SYNC_OUTPUT_CAP` ersetzt

## Tests

- `npx vitest run` — alle 677 Tests in 56 Files grün.
- `pnpm -r exec tsc --noEmit` — clean.
