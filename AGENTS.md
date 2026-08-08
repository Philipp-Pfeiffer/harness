# AGENTS.md

**Projekt:** Harness — selbstgebautes Agent-Harness in TypeScript.

## Behavioral Guidelines

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

### 5. Commit Discipline

**Jede abgeschlossene Änderung wird sofort committet.**

- Committe nach jedem logischen Arbeitsschritt, nicht erst am Ende einer Session.
- Ein Commit pro Changeset — klein, fokussiert, mit klarem Message-Präfix (`fix:`, `feat:`, `refactor:`, `docs:`, `test:`).
- So bleiben einzelne Changes nachverfolgbar, revertierbar und reviewbar.
- Vor dem Commit: `tsc --noEmit` clean + relevante Tests grün.
- Keine WIP-Commits mit Platzhaltern. Liefer den kompletten Change.

### 6. Change Documentation

**Alle wichtigen Änderungen werden in `docs/changes/` dokumentiert.**

- Ein Markdown-File pro Changeset, benannt nach Schema: `fix-<topic>.md`, `feat-<topic>.md`, `refactor-<topic>.md`.
- Inhalt: Problem/Symptom, Befund, was geändert wurde, welche Dateien, welche Tests.
- Kurz und präzise — kein Roman, aber genug Kontext um den Change ohne Git-Archäologie zu verstehen.
- Wird zusammen mit dem Code-Commit geliefert, nicht nachträglich.

---

## Projekt-Konventionen

- **Stack:** Node.js, TypeScript strict, ESM. Kein CommonJS, kein Python, kein Go.
- **Foundation:** Nur `@mariozechner/pi-ai`. Keine weiteren pi-Pakete oder Frameworks.
- **State vs. Knowledge:** State (Todos, Tasks) → JSON/SQLite. Wissen → Markdown. Niemals beides gemischt.
- **TS strict:** `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`. Kein `any`, wenn nötig `unknown` + Narrowing.
- **Exports:** Named Exports bevorzugt, keine Default-Exports (außer Framework verlangt es).
- **Async:** Async/await, keine raw `.then`-Ketten.
- **File-IO:** `node:fs/promises`, nie synchron.
- **Errors:** Typisierte Subklassen, keine String-throws.
- **Secrets:** API-Keys nie loggen. `process.env`-Werte beim Logging maskieren.
- **Tools:** Ein Tool pro Datei, `export const <name>Tool: Tool`.

## Architektur

- Bindende Design-Entscheidungen liegen als ADRs im Harness Tracker (Notion).
- **Konflikt:** Code vs. ADR → ADR gewinnt.
- Phase 1: Single-Agent-Loop. Keine Sub-Agents, kein MCP, kein TUI.
- Output wird als AST gerendert, Channels haben eigene Render-Profile.

### Runtime-Topologie: HOME vs. STATE vs. CODE

**`src/config/paths.ts` ist die einzige Pfad-Quelle.** Niemand sonst baut Pfade selbst.

| Kategorie | Pfad | Inhalt | Git? |
|-----------|------|--------|------|
| **HOME** (durable) | `$HARNESS_HOME` (Default `~/harness`) | `core.md`, `AGENTS.md`, `config.json`, `memory/`, `sources/`, `skills/`, `agents/` | Eigenes Git |
| **STATE** (ephemeral) | `$HARNESS_STATE` (Default `~/.harness`) | `sessions/`, `metrics/`, `index/`, `logs/`, `jobs/`, `daemon.pid`, `daemon.sock` | Nein |
| **CODE** | Repo | `src/`, `prompts/`, `tests/`, `docs/` | Ja |

- **HOME** ist portabel und wird von mehreren Agent-Prozessen geteilt.
- **STATE** ist regenerierbar — `harness reindex` baut den Index neu.
- **Workspace** (cwd) ≠ **HOME** — niemals vermischen.
- Env-Overrides: `HARNESS_HOME`, `HARNESS_STATE`, `XDG_STATE_HOME`.
- Der `harness migrate-home` Command migriert Legacy-Substrat nach `$HARNESS_HOME`.
- Siehe: `docs/architecture/topology.md`

### Selbst-Modifikation

Der Daemon kann sich selbst deployen und neustarten. Bei Selbst-Änderungs-Aufträgen gilt das Runbook `docs/architecture/self-modification.md` (verbindlich, hier nicht dupliziert):

- Code-Änderungen nur auf Feature-Branches in Worktrees, nie auf `main` oder im Produktiv-Checkout.
- Build/Test-Gate vor jedem Deploy; Code-Deploys nur nach Philipps Bestätigung via `/deploy <branch>`.
- Config (`~/harness/.env`, `config.json`) autonom, Restart nur über Deferred Restart.
- No-Gos: `kill -9` auf den Daemon, zweiter Daemon, `--reset-whatsapp-auth` (außer Nummernwechsel), Edits an `dist/`, Restart ohne grünen Build.

## Bei Unsicherheit

- Frag explizit nach, statt zu spekulieren.
- Wenn ein ADR fehlt für eine Entscheidung: stoppen und fragen.
- Wenn ein Tool potenziell unsicher ist: stoppen und fragen.

## Doku

- **Tool-Specs:** `docs/tools/` (exec, readFile, write, edit, process, file_state, web_fetch, web_search)
- **Architektur:** `docs/architecture/` (topology, memory, cli, phase-1-overview)
- **Change-Logs:** `docs/changes/`
- **Audit-Reports:** `docs/audit/`
- **Research:** `docs/research/`
