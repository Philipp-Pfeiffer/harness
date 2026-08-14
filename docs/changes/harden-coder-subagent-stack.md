# fix: Coder-Subagent-Stack härten (3 Hebel aus Audit 14.08.)

## Problem/Symptom

Der Coder-Subagent hält die Persona überwiegend ein, aber drei Schwachstellen
führen zu:

1. **"DONE trotz rotem Test"** — der Agent meldet DONE, obwohl Tests/typecheck
   nicht grün sind (Persona ließ das zu).
2. **"done ohne Commit"** — der Runner finalisierte Tasks als `done`, ohne dass
   im Worktree ein Commit entstand (leerer Diff).
3. **Doppelte/dead Runs** — `~`- oder relative `repo`-Pfade (Worktree-Fehler)
   und Briefings ohne Verifikations-/Done-Kriterium; zusätzlich
   `exec_command`-statt-`exec`-Aufrufe, weil die exakte Tool-Liste nicht im
   System-Prompt stand.

## Befund

- `subagent-coder.md` erlaubte `DONE` trotz roter Checks; Report-Felder
  `Verification`/`Open issues` waren optional.
- `asyncAgentRunner.ts` hatte keinen Post-Run-Nachweis eines Commits; die
  Tool-Schemata wurden dem Subagenten nur im Briefing erwähnt, nie als
  System-Prompt-Inhalt.
- `subagent.ts` validierte weder `repo` (absolut, ohne `~`) noch das Briefing
  (Verifikation + Done-Kriterium) und hatte keine Dedup-Erkennung.

## Was geändert wurde

### 1. Persona (`packages/core/prompts/subagent-coder.md`)
- "Verify or report" → "hard rule": bei nicht-grünen Checks NIE `DONE`,
  stattdessen `BLOCKED`/`PARTIAL` mit exaktem roten Kommando + Auszug.
- Bei leerem Diff (kein Commit auf dem Task-Branch) NIE `DONE`.
- Report-Format: `Verification` und `Open issues` sind Pflichtfelder;
  `Verification` listet Kommandos samt Exit-Code/Ergebnis.

### 2. Runner-Guard (`packages/core/src/agent/asyncAgentRunner.ts`)
- Post-Run-Check nach `agent.run`: im Worktree `git status --porcelain` +
  `git log <base>..HEAD` (Basis = Default-Branch des Repos, dynamisch
  aufgelöst, damit auch frische lokale Repos ohne Remote funktionieren).
  Leerer Diff/kein Commit → Task `error`, Summary z. B. "kein Commit /
  leerer Diff" — analog zum bestehenden Unparsed-Tool-Call-Guard.
- Tool-Schema-Injection: exakte Tool-Liste mit Parameternamen/Typen wird in
  den System-Prompt gelegt (`## Available tools`), aufgebaut über die
  testbare `buildCoderSystemPrompt()`.
- Neuer `gitUtil.ts` (minimaler Git-Wrapper, wirft nie).

### 3. Tool-Validierung (`packages/core/src/tools/subagent.ts`)
- Fail-closed bei `action: "start"`:
  - `repo` muss absoluter Pfad sein (kein `~`, kein relativer Pfad, kein
    `..`) — sonst Fehler, kein Worktree.
  - `task` muss Verifikations- (test/build/typecheck/verifiziere/…) UND
    Done-Kriterium (fertig wenn/done wenn/Verifikation/…) enthalten —
    sonst Fehler mit kurzer Begründung.
- Dedup vor `start`: gleiche `repo` + überlappendes Task-Thema eines
  laufenden Tasks → Warnung (kein harter Block), im Start-Report sichtbar.

### 4. Tests
- `asyncAgentRunner.test.ts`: leerer Diff → `error` (Summary "kein Commit"),
  vorhandener Commit → `done`, Tool-Schema-Injection enthält echte
  Parameternamen (kein `exec_command`).
- `subagentTool.test.ts`: `~`-Pfad und Briefing ohne Done-Kriterium werden
  abgelehnt (Runner wird nicht aufgerufen); absoluter Pfad + Verifikation
  wird akzeptiert; Dedup-Warnung bei überlappendem laufendem Task, keine
  Warnung bei disjointem Thema. Bestehende Fälle auf Briefings mit
  Verifikation+Done-Kriterium angehoben.

## Dateien

- `packages/core/prompts/subagent-coder.md`
- `packages/core/src/agent/asyncAgentRunner.ts`
- `packages/core/src/agent/gitUtil.ts` (neu)
- `packages/core/src/lib.ts` (Export git/GitResult)
- `packages/core/src/tools/subagent.ts`
- `packages/core/tests/subagent/asyncAgentRunner.test.ts`
- `packages/core/tests/subagent/subagentTool.test.ts`

## Tests

- `pnpm build` grün
- `pnpm typecheck` grün (core + agent)
- Subagent-Suiten: 35/35 grün
- Gesamte Core-Suite: 633/634 — einziger Fehler ist der vorbestehende
  `exec.test.ts`-sudo-Test (kein passwordless sudo auf dieser Maschine,
  auch auf `main` rot; keine Regression).
