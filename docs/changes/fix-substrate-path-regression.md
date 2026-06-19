# Fix: Substrat-Pfade landen im Code-Repo (Runtime-Regression)

**Datum:** 2026-06-19
**Branch:** `fix/status-token-metrics` (post-merge mit `feat/workspace-arch`)
**Scope:** Root-Cause-Fix — Agent-Substrat liegt zur Laufzeit im Code-Repo statt in `$HARNESS_HOME` / `$HARNESS_STATE`

## Root Cause

Drei separate Probleme führten dazu, dass Pfade trotz `feat/workspace-arch`-Merge auf das Repo auflösten:

### 1. Veralteter `dist/`-Build (primärer Auslöser)

Der `dist/`-Ordner enthielt noch den Pre-Merge-Code. `npm start` führt
`node dist/index.js` aus, nicht die Source-Dateien. Der alte `dist/index.js`
baute DB-Pfade als `<cwd>/.qmd/index.sqlite` und setzte `HARNESS_PROJECT_ROOT = process.cwd()`.

**Fix:** `npx tsc` (Rebuild) ausgeführt.

### 2. `HARNESS_PROJECT_ROOT` Env-Pollution in `index.tsx`

`src/index.tsx:26` setzte `process.env.HARNESS_PROJECT_ROOT = process.cwd()`.
Dieser Wert wurde von `coreMemory.ts` und `config.ts` als Pfad-Fallback genutzt,
was `core.md` und `harness.config.json` im Repo-Root suchte (statt in `$HARNESS_HOME`).

**Fix:** Zeile entfernt. `HARNESS_PROJECT_ROOT` wird nicht mehr gesetzt.
Alle Konsumenten nutzen jetzt `resolveHarnessPaths()`.

### 3. `coreMemory.ts` — Fallback auf `HARNESS_PROJECT_ROOT`/`process.cwd()`

`loadCoreMemoryRaw(corePath?)` hatte einen Optional-Parameter mit Fallback auf
`resolve(process.env.HARNESS_PROJECT_ROOT ?? process.cwd(), "core.md")`.
Obwohl `App.tsx` bereits `paths.core` übergab, war der Fallback eine ticking time bomb.

**Fix:** `corePath` ist jetzt required (`string` statt `string?`).
Kein Fallback mehr — Aufrufer müssen `paths.core` übergeben.

### 4. `config.ts` — `HARNESS_PROJECT_ROOT` als cwd-Fallback

`loadConfig()` nutzte `process.env.HARNESS_PROJECT_ROOT ?? process.cwd()` für
den Legacy-Config-Pfad `cwd/harness.config.json`. Mit gesetztem `HARNESS_PROJECT_ROOT`
wurde der Repo-Root statt des echten cwd verwendet.

**Fix:** Auf `process.cwd()` vereinfacht (entspricht der Legacy-Intention).

### 5. `workspace/` Subdirectory-Erstellung in `index.tsx`

`index.tsx` erstellte `<repo>/workspace/` und führte `process.chdir()` dorthin aus.
Das ist nicht das `HARNESS_HOME`-Konzept, sondern das "Workspace"-Konzept (File-Tool-cwd).
Aber die ungefragte Erstellung eines `workspace/`-Subdirs im Repo ist nicht erwünscht.

**Fix:** `mkdir(workspace)` und `process.chdir(workspace)` entfernt.
Workspace = `cwd` (wo der User harness startet). Kein Subdir, kein chdir.

## Konsumenten-Audit (grep-Nachweis)

Nach dem Fix verbleiben nur noch legitime `process.cwd()`-/`projectRoot`-Nutzungen:

| Datei | Nutzung | Status |
|---|---|---|
| `src/index.tsx:14` | `projectRoot` nur im `migrate-home` Subcommand | ✅ Korrekt (Migration braucht die Legacy-Quelle) |
| `src/cli/migrateHome.ts` | `projectRoot` als Funktionsparameter für Migration | ✅ Korrekt |
| `src/cli/config.ts:34` | `cwd` für Legacy-Config `cwd/harness.config.json` | ✅ Bewusst (deprecated Candidate) |
| `src/core/statusSummary.ts:209` | `workspace` für `/status`-Anzeige | ✅ Anzeige, kein Substrat-Pfad |
| `src/cli/App.tsx:153,818` | StatusBar `/status` workspace-Anzeige | ✅ Anzeige |
| `src/tools/exec.ts:23` | Tool-Beschreibungsstring | ✅ Kein Code |

**Kein Konsument baut Substrat-Pfade an `resolveHarnessPaths()` vorbei.**

## Tests

- Neuer Test: `defaults do not resolve to cwd or repo` in `tests/config/paths.test.ts`
  — Verifiziert ohne gesetzte Env-Vars, dass HOME/STATE nicht unter cwd liegen.
- Alle 379 Tests grün.
- TypeScript clean (`tsc --noEmit`).
- `dist/` neu gebaut.

## Bereinigung bereits angelegter Repo-Ordner

Wenn bereits `memory/`, `sources/`, `.qmd/` oder `core.md` mit echten Daten im Repo liegen:

```bash
# 1. In $HARNESS_HOME verschieben (idempotent, mit --dry-run):
harness migrate-home --dry-run    # zeigt was verschoben würde
harness migrate-home              # führt die Migration aus

# 2. QMD-Index wird nicht verschoben (regenerierbar).
#    Beim nächsten Start wird er unter $HARNESS_STATE/index/ neu erstellt.

# 3. Falls core.md und AGENTS.md im Repo liegen und getrackt sind:
#    Diese Dateien sind in .gitignore aufgeführt — falls sie versehentlich
#    committed wurden, mit `git rm --cached` aus dem Tracking entfernen.
```

**`.gitignore` bereits aktiv:** `memory/`, `.qmd/`, `workspace/` sind eingetragen.
"src/config/paths.ts" liegt im Code-Repo (korrekt).
