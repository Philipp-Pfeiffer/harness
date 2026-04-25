# AGENTS.md

**Projekt:** Harness — selbstgebautes Agent-Harness in TypeScript.
Endprodukt: Cliffford V2 (Nachfolger des aktuellen OpenClaw-basierten Cliffford).

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

## Bei Unsicherheit

- Frag explizit nach, statt zu spekulieren.
- Wenn ein ADR fehlt für eine Entscheidung: stoppen und fragen.
- Wenn ein Tool potenziell unsicher ist: stoppen und fragen.
