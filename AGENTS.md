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

---

## Tool: readFile (MVP)

**File:** `src/tools/readFile.ts`

### Spec (Kurzfassung)
- Liest UTF-8-Text und PDF-Dateien.
- Pfad: absolut, relativ (CWD), `~` für Home.
- Optional `lineStart`/`lineEnd` (1-indexed, inklusive).
- 64KB Größenlimit auf extrahierten Text. Bei Überschreitung → Error mit Hinweis auf lineStart/lineEnd.
- Line-Range: `lineEnd` > Dateizeilen = silent clamp.
- PDF: Magic-Byte-Erkennung (`%PDF-`), pdfjs-dist für Extraktion.

### Output-Format
- Plain Text ohne Range: rohe Inhalte
- Plain Text mit Range: `--- Lines X-Y of Z ---\n<content>`
- PDF: `--- PDF, N pages ---\n<text>`

### Error-Cases
- `File not found: <path>`
- `Permission denied: <path>`
- `Path is a directory, not a file: <path>`
- `Extracted text exceeds 64 KB (<X> bytes). Use lineStart/lineEnd to read a range.`
- `Unsupported binary format (null byte detected). Only UTF-8 text and PDF are supported.`
- `Failed to parse PDF: <error>`

### MVP-Scope (was NICHT drin ist)
- Kein Path-Scoping / Workspace-Root Isolation (Spec: "keine Path-Restrictions")
- Kein `writeFile` / `editFile`
- Kein Logger
- Kein Binary-Decode (nur Error bei Null-Byte)
- Keine weiteren Formate (kein Word, kein HTML, etc.)

## Tool: bash (MVP)

**File:** `src/tools/bash.ts`

### Spec (Kurzfassung)
- Führt Bash-Commands aus via `child_process.spawn` mit `shell: true`.
- Argument-Schema: `{ command: string (minLength: 1), cwd?: string }`.
- CWD: expandiert `~`, resolved gegen CWD, Validierung dass es ein Directory ist.
- Output: stdout und stderr separat gesammelt, 64KB cap via Buffer.
- Timeout: 30s default, SIGTERM → 5s → SIGKILL (Process-Group).
- No-Fly-List für destruktive Commands (rm -rf, dd, mkfs, Fork-Bombs, etc.).

### Output-Format
```
--- stdout ---
{stdout or (empty)}
--- stderr ---
{stderr or (empty)}
--- exit ---
code: {exitCode}, signal: {signal}
[...truncated, original size approx X bytes]
```

### No-Fly-List (Best-Effort, kein Security-Layer)
| Pattern | Reason |
|---------|--------|
| `rm -rf` | rm with -rf/-fr/-Rf is blocked |
| `dd if=` | dd with input file is blocked |
| `mkfs` | mkfs.* is blocked |
| `> /dev/sd*` | Direct write to disk device blocked |
| `:(){ :|:& };:` | Fork bomb pattern blocked |
| `shutdown/reboot/halt/poweroff` | System power command blocked |
| `kill -9 1` | Killing init (PID 1) blocked |
| `chmod -R 0*0+ /` | Recursive chmod 000 on root blocked |

### Error-Cases
- Validation-Fail → `Invalid arguments: ...`
- No-Fly-Match → `Blocked destructive command: {reason}. {hint}`
- Invalid CWD → `cwd does not exist or is not a directory`
- Spawn-Failure → `Failed to spawn: ...`
- Timeout → `Command timed out after 30s and was terminated.`

### MVP-Scope (was NICHT drin ist)
- Kein Path-Scoping / Workspace-Root Isolation
- Kein Security-Layer (No-Fly ist best-effort, kein Anti-Bypass)
- Kein Logger
- Keine Shell-Builtin-Commands außer Standard-Pipes/-Redirects
