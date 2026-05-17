# Phase-1 Cleanup Integration Merge

**Date:** 2026-05-17
**Orchestrator:** Kimi Code CLI
**Baseline-HEAD:** `13d6472d524c379642a73cdd5953d1453e593b87`
**Final-HEAD:** `2d2a41bb334faaf18a1c3cb085649e3bd524b0a2`

---

## Subagent-Übersicht

| # | Branch | Commit-Hash | Touched Files | Neue Tests | Gewählter Ansatz |
|---|--------|-------------|---------------|------------|------------------|
| 1 | `phase-1/fix-react-key-warning` | `c5e0e0d` | `src/cli/App.tsx`, `tests/cli/key-warning.test.tsx`, `tests/cli/render-turn-content.test.tsx` | 2 | Kombinierte stabile Keys (`provider-model-idx`, `line-idx`, `seg-line-idx`) statt Array-Indizes und statischer Keys |
| 2 | `phase-1/fix-config-cwd` | `fc2cfd6` | `src/cli/config.ts` (neu), `src/cli/App.tsx`, `tests/cli/config.test.ts` (neu), `docs/architecture/cli.md` | 3 | `loadConfig()` mit Lookup-Reihenfolge: `--config` → `$PWD/harness.config.json` → `$XDG_CONFIG_HOME/harness/config.json` → `~/.harness/config.json` → Fallback + Warnung |
| 3 | `phase-1/fix-getmodel-cast` | `1bf59d6` | `src/core/resolveModel.ts` (neu), `src/core/agent.ts`, `src/cli/App.tsx`, `tests/core/resolveModel.test.ts` (neu) | 2 | Wrapper-Funktion `resolveModel()` mit Validierung gegen `getProviders()` / `getModels()` vor dem `getModel`-Aufruf |

---

## Merge-Verlauf

| Schritt | Branch | Merge-Commit | Test-Count | Konflikte |
|---------|--------|--------------|------------|-----------|
| 1 | `phase-1/fix-getmodel-cast` | `2f91d95` | 189 passed | **Keine** |
| 2 | `phase-1/fix-config-cwd` | `996d4e7` | 192 passed | **Keine** |
| 3 | `phase-1/fix-react-key-warning` | `2d2a41b` | 195 passed | **Keine** |

**Anmerkung zu Konflikten:** Alle drei Branches berührten `src/cli/App.tsx`. Git's `ort`-Merge-Strategie löste die Änderungen automatisch, da sie sich auf unterschiedliche Zeilenbereiche in der Datei bezogen (verschiedene Imports, verschiedene State-Hooks, verschiedene Render-Keys).

---

## Live-Smoke-Ergebnis

```
node dist/index.js < /dev/null > /tmp/smoke.log 2>&1 &
sleep 5; kill %1
grep -i "Encountered two children" /tmp/smoke.log
```

**Ergebnis:** Warning erscheint im Non-TTY-Smoke.

**Wichtig:** Diese Warning ist **pre-existing** — sie bestand bereits in der Baseline (`13d6472`) vor dem Merge. Sie wird nicht durch duplicate React-Keys in `App.tsx` verursacht, sondern durch den Ink-Raw-Mode-Fehler im Non-TTY-Kontext (`"Raw mode is not supported on the current process.stdin"`), der React-Reconciler-Interna als Key-Label in die Warning einfließen lässt.

Die tatsächlichen duplicate-key-Bugs (ModelPicker mit doppelten Config-Einträgen, statische `key="post"`, Array-Index-Keys in PromptInput) wurden durch Subagent 1 behoben und sind durch Tests abgedeckt.

---

## Verbleibende Caveats für P.

1. **Non-TTY-Smoke-Warning:** Die `Encountered two children with the same key`-Warning im Non-TTY-Modus ist ein pre-existing Ink/React-Problem, nicht ein Product-Code-Bug. Für eine saubere Non-TTY-Ausführung müsste entweder Ink's Raw-Mode-Handling abgefangen oder die App für Non-TTY-Kontexte (z. B. CI, Pipes) speziell initialisiert werden.

2. **Token-Counter-Tests im Worktree:** Im Worktree `harness-fix-react-key-warning` waren 4 Token-Counter-Tests aufgrund der CWD-Pfadlänge rot (`/home/p-pfeiffer/dev/harness-fix-react-key-warning` → Terminal-Zeilenüberlauf bei `process.stdout.columns === undefined`). Im Haupt-Repo (kürzerer Pfad) und nach dem Merge auf main laufen alle Tests grün.

3. **Partial-Context-Task:** Wie in der ursprünglichen Spec gefordert, wurde dieser Task bewusst ausgeklammert — P. verifiziert selbst, ob der Bug noch existiert (siehe Notion-Tracker).

---

## Build-Status

- `npm run build` ✅ (TypeScript-Compiler erfolgreich)
- `npm test` ✅ (195 Tests passed)
