# Change: typebox-Dependency deklarieren + pnpm-lock.yaml committen

## Symptom / Motivation

- Der Worktree- und jeder frische Deploy-Build schlug fehl: `packages/core`
  importiert `Value` aus `typebox/value` (`exec.ts`, `process.ts`,
  `core/agent.ts`), aber `typebox` war in keinem Package deklariert.
- Im Haupt-Checkout funktionierte das nur, weil dort eine **hand-installierte
  Root-`typebox@1.1.33`** lag (vom 26.04.), die den Subpath `typebox/value`
  exportiert. Frisches `pnpm install` installiert die neueste `typebox@1.3.11`,
  die `typebox/value` nicht mehr exportiert und nicht gehoisted wird → der
  erste `/deploy` wäre mit Exit 2 (Rollback) geendet.
- Zusätzlich: `packages/agent` importiert `chalk` in `cli/App.tsx` ohne
  Dependency-Eintrag — im Fresh-Clone ebenso ein Build-Break.
- `pnpm-lock.yaml` war in `.gitignore` → Installationen waren nicht
  reproduzierbar (das Root-Hoisting-Problem entstand genau daraus).

## Befund / Änderungen

1. **`packages/core/package.json`:** `"typebox": "1.1.33"` als Dependency —
   exakte Pin (kein `^`), damit reproduzierbar exakt die Version installiert
   wird, deren `typebox/value`-Subpath der Code nutzt. Keine Import-
   Umschreibung auf `@sinclair/typebox` (deren 1.x-Value-API weicht ab).
2. **`packages/agent/package.json`:** `"chalk": "^5.6.2"` — importiert in
   `cli/App.tsx`, bisher nur via Hoisting im Haupt-Checkout auflösbar.
3. **`.gitignore`:** Zeile `pnpm-lock.yaml` entfernt; `package-lock.json` und
   `yarn.lock` bleiben ignoriert.
4. **`pnpm-lock.yaml`:** neu generiert und committet (alle `typebox@1.1.33`
   + `chalk@5.6.2`-Auflösungen enthalten).

## Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `packages/core/package.json` | `typebox` 1.1.33 (exakt) deklariert |
| `packages/agent/package.json` | `chalk` ^5.6.2 deklariert |
| `.gitignore` | `pnpm-lock.yaml` aus ignore entfernt |
| `pnpm-lock.yaml` | **Neu**, committet (~222 KB) |

## Verifikation

- **Worktree** (`~/dev/harness-safe-deploy`): `pnpm install && pnpm build &&
  pnpm typecheck && pnpm --filter @harness/agent test` — **437 Tests grün**,
  ohne Hand-Installation.
- **Fresh-Clone** (`/tmp/harness-fresh-check`, `git clone` vom Haupt-Checkout
  auf dem Branch `feat/safe-deploy-runbook`): `pnpm install && pnpm build &&
  pnpm typecheck && pnpm --filter @harness/agent test` — **grün ohne jede
  Hand-Installation** (42 Test-Files, 437 Tests). Danach Klon + temporärer
  Branch (`fresh-clone-source`) aufgeräumt, Haupt-Checkout unverändert.
- `typebox/value` löst im Fresh-Clone korrekt auf:
  `.pnpm/typebox@1.1.33/node_modules/typebox/build/value/index.mjs`.

## Commit

`413281d fix: declare typebox dependency, commit pnpm-lock.yaml for reproducible deploys`
(4 Dateien, +7003/-1; Lockfile ~222 KB).
