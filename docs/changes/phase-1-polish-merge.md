# Phase-1 Polish Integration Merge

**Date:** 2026-05-17
**Orchestrator:** Kimi Code CLI
**Baseline-HEAD:** `8a71829a27987f927a08e7f675eabbe074b6d7e8` (195 Tests)
**Final-HEAD:** `f6aa91513d872782ab5ecbbfd5c21edb263ea3ff` (208 Tests)

---

## Subagent-Übersicht

| # | Branch | Commit-Hash | Touched Files | Neue Tests | Gewählter Ansatz |
|---|--------|-------------|---------------|------------|------------------|
| 1 | `phase-1/fix-token-counter` | `67f865e` | `src/cli/App.tsx`, `tests/cli/App.test.tsx`, `docs/architecture/cli.md` | 3 | Kumulatives Addieren von `result.usage` auf `sessionUsage`; `event.type === "usage"` ignoriert für Session-Aggregation |
| 2 | `phase-1/fix-tool-card-frame` | `69acf77` | `src/cli/App.tsx`, `tests/cli/ToolCard.test.tsx` | 3 | Width-Berechnung korrigiert (Top-Bar bündig), Title-Stubs symmetrisch (2-Strich-Stub links + Füllung rechts), Overflow-Content auf Card-Einrückung |
| 3 | `phase-1/polish-markdown-rendering` | `6f1bf36` | `src/cli/App.tsx`, `src/core/agent.ts`, `tests/cli/markdown-rendering.test.tsx`, `docs/architecture/cli.md` | 6 Snapshots | System-Prompt-Tweak ("Verzichte auf Überschriften, nutze Bullet-Listen") + `marked-terminal` Config (`tab: 2`, `showSectionPrefix: false`, `codespan` mit Backticks) |

---

## Merge-Verlauf

| Schritt | Branch | Merge-Commit | Test-Count | Konflikte |
|---------|--------|--------------|------------|-----------|
| 1 | `phase-1/fix-token-counter` | `f787102` | 199 passed | **Keine** |
| 2 | `phase-1/fix-tool-card-frame` | `f54a6a4` | 202 passed | **Keine** |
| 3 | `phase-1/polish-markdown-rendering` | `f6aa915` | 208 passed | **Keine** |

**Anmerkung zu Konflikten:** Alle drei Branches berührten `src/cli/App.tsx`. Git's `ort`-Merge-Strategie löste die Änderungen automatisch (verschiedene Zeilenbereiche: State-Handling, ToolCard-Rendering, marked-terminal Config).

---

## Pro Subagent: Detail-Zusammenfassung

### Fix Token Counter (Subagent 3 — erfolgreich)
**Identifizierte Hypothese:** H1 zutraf — der Counter zeigte nur den letzten Turn statt der Session-Summe.

**Ursache:** `setSessionUsage(result.usage)` überschrieb den State bei jedem `agent.run()` komplett, statt auf den vorherigen Wert aufzuaddieren. Zusätzlich hätte das Blind-Setzen von `event.type === "usage"`-Events zu Doppelzählung bei Multi-Turn-Runs geführt.

**Fix:**
- `result.usage` wird am Ende jedes Runs session-kumulativ addiert
- `event.type === "usage"` wird für Session-Aggregation ignoriert
- `/clear` setzt `sessionUsage` auf `undefined` zurück
- `/model`-Switch lässt den Counter unverändert laufen

### Fix Tool Card Frame (Subagent 2 — Timeout, aber Commit erfolgreich gepusht)
**Drei Defekte behoben:**

1. **Top-Bar zu kurz:** `width` wurde falsch berechnet (nicht bis zum Terminal-Rand). Fix: `Math.max(20, (process.stdout.columns || 80) - 4)` als Card-Breite, Border korrekt ausgerichtet.
2. **Asymmetrischer Title-Stub:** Links war der Stub länger als rechts. Fix: Konstante 2-Strich-Stub links (`┌─ `), Title-Block, dann Füllstriche bis zum rechten Eck (`─┐`).
3. **Content-Overflow-Alignment:** Überlaufender Text fließte unter die Card. Fix: Überlaufender Content bleibt auf der Card-Content-Einrückung (visuell konsistent).

### Polish Markdown Rendering (Subagent 1 — Timeout, im Worktree fertiggestellt)
**Zwei Stellschrauben:**

1. **System-Prompt-Tweak:** `DEFAULT_SYSTEM_PROMPT` in `src/core/agent.ts` ergänzt:
   > "Verzichte auf Markdown-Überschriften (#, ##, ###). Nutze Bullet-Listen (-) für Aufzählungen. Code-Blöcke und Inline-Code sind erwünscht."

2. **marked-terminal-Config:**
   - `tab: 2` (konsistente Einrückung)
   - `showSectionPrefix: false` (keine `#`-Prefixe vor Überschriften)
   - `firstHeading: chalk.cyan.bold.underline` (H1 visuell hervorgehoben)
   - `codespan: (text) => chalk.gray(\`\`\`${text}\`\`\`)` (Inline-Code mit Backticks)
   - `renderMarkdown()` ersetzt `* ` durch `• ` für konsistente Bullet-Chars

---

## Live-Smoke-Ergebnis

- `npm run build` ✅ Grün
- `npm test -- --run` ✅ **208 Tests passed**
- Non-TTY-Smoke: Pre-existing Key-Warning (Ink Raw-Mode, kein Produkt-Code-Bug)

---

## Verbleibende Caveats für P.

1. **Non-TTY-Smoke-Warning:** Pre-existing — wird durch Ink's Raw-Mode-Handling im Non-TTY-Kontext verursacht.
2. **Partial-Context-Task:** Bewusst ausgeklammert — P. verifiziert selbst.

---

## Build-Status

- `npm run build` ✅ (TypeScript-Compiler erfolgreich)
- `npm test` ✅ (208 Tests passed, 20 Test-Files)
