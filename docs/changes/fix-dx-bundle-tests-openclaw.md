# fix: DX-Bundle — test scripts, prestart build, OpenClaw→Harness rename

**Datum:** 2026-07-22

## Problem/Symptom

1. **Test-Skripte hängen im Watch-Modus:** `pnpm -r test` ruft `vitest` ohne `run` auf → Watch-Modus → terminiert nie in CI/Scripts ohne `CI=true`.
2. **`npm start` kann veralteten Build ausführen:** Kein Prebuild-Schritt vor `start` → potenziell veraltete `dist/` wird ausgeführt.
3. **node-pty Native-Modul:** 6 Test-Files schlugen fehl mit `Cannot find module .../pty.node`.
4. **test-run.ts bricht Library-Build:** `src/test-run.ts` ruft `agent.run()` mit falscher Signatur auf.
5. **Staler OpenClaw-Name:** Test-Snapshots und Prompts enthalten noch den alten Projektnamen "OpenClaw" statt "Harness".

## Befund

1. `packages/core/package.json` und `packages/agent/package.json` haben `"test": "vitest"` statt `"test": "vitest run"`.
2. Root `package.json` und `packages/agent/package.json` haben keinen `prestart`-Script.
3. node-pty ist bereits korrekt gebaut (`node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/build/Release/pty.node` existiert). `pnpm approve-builds` meldet keine ausstehenden Packages. Alle 56 Test-Files laden erfolgreich.
4. `src/test-run.ts` existiert nicht im Repo. Die tsconfig-Dateien haben kein `exclude` für test-run.ts. Kein Eingriff nötig.
5. "OpenClaw" gefunden in:
   - `packages/core/prompts/system-prompt.md` (Zeile 2)
   - `packages/agent/agents/default/agent.md` (Zeile 4)
   - `packages/core/tests/prompts.test.ts` (Zeile 32: `expect(result).toContain("OpenClaw")`)
   - `packages/core/tests/core/libSurface.test.ts` (Zeile 42: `expect(result).toContain("OpenClaw")`)

## Was geändert wurde

### 1. Test-Skripte: `vitest run`
- `packages/core/package.json`: `"test": "vitest"` → `"test": "vitest run"`
- `packages/agent/package.json`: `"test": "vitest"` → `"test": "vitest run"`

### 2. Prebuild-/Clean-Step für `npm start`
- Root `package.json`: `"prestart": "pnpm build"` hinzugefügt (vor `start`)
- `packages/agent/package.json`: `"prestart": "pnpm build"` hinzugefügt (vor `start`)

### 3. node-pty Native-Modul
- Kein Eingriff nötig — Modul ist bereits korrekt gebaut.

### 4. test-run.ts
- Kein Eingriff nötig — Datei existiert nicht, tsconfig ist clean.

### 5. OpenClaw → Harness
- `packages/core/prompts/system-prompt.md`: "OpenClaw" → "Harness"
- `packages/agent/agents/default/agent.md`: "OpenClaw" → "Harness"
- `packages/core/tests/prompts.test.ts`: `toContain("OpenClaw")` → `toContain("Harness")`
- `packages/core/tests/core/libSurface.test.ts`: `toContain("OpenClaw")` → `toContain("Harness")`

## Dateien

- `package.json`
- `packages/core/package.json`
- `packages/agent/package.json`
- `packages/core/prompts/system-prompt.md`
- `packages/agent/agents/default/agent.md`
- `packages/core/tests/prompts.test.ts`
- `packages/core/tests/core/libSurface.test.ts`

## Tests

- `npx vitest run`: 56 Test-Files, 677 Tests — alle grün.
- Pre-existing typecheck-Error in `webSecurity.ts` (TS2694) ist nicht Teil dieses Changes und unberührt.
