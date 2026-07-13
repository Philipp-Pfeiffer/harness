# AGENTS.md

**Projekt:** Harness — selbstgebautes Agent-Harness in TypeScript.
Endprodukt: Harness (Nachfolger des aktuellen OpenClaw-basierten Harness).

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
| **HOME** (durable) | `$HARNESS_HOME` (Default `~/harness`) | `core.md`, `AGENTS.md`, `config.json`, `memory/`, `sources/`, `skills/` | Eigenes Git |
| **STATE** (ephemeral) | `$HARNESS_STATE` (Default `~/.harness`) | `sessions/`, `metrics/`, `index/`, `logs/`, `daemon.pid`, `daemon.sock` | Nein |
| **CODE** | Repo | `src/`, `prompts/`, `tests/`, `docs/` | Ja |

- **HOME** ist portabel und wird von mehreren Agent-Prozessen geteilt.
- **STATE** ist regenerierbar — `harness reindex` baut den Index neu.
- **Workspace** (cwd) ≠ **HOME** — niemals vermischen.
- Env-Overrides: `HARNESS_HOME`, `HARNESS_STATE`, `XDG_STATE_HOME`.
- Der `harness migrate-home` Command migriert Legacy-Substrat nach `$HARNESS_HOME`.
- Siehe: `docs/architecture/topology.md`

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
- Kein Logger
- Kein Binary-Decode (nur Error bei Null-Byte)
- Keine weiteren Formate (kein Word, kein HTML, etc.)

## Tool: exec (MVP)

**File:** `src/tools/exec.ts`

### Spec (Kurzfassung)
- Führt CLI-Commands aus via `child_process.spawn` mit `shell: true`.
- Parameter: `command` (req), `cwd?`, `env?`, `stdin?`, `timeout?`, `pty?`, `elevated?`, `background?`, `yieldMs?`.
- CWD: expandiert `~`, resolved gegen CWD, Validierung dass es ein Directory ist.
- Output: stdout und stderr separat gesammelt, 64KB cap via Buffer.
- Timeout: 30s default, SIGTERM → 5s → SIGKILL (Process-Group).
- No-Fly-List für destruktive Commands.

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

### Extended Features (Phase 2)
- **pty**: PTY-Modus für interaktive CLIs (vim, htop, etc.) — stdout+stderr merged, ANSI preserved
- **elevated**: Prefix `sudo -n`, passwordless sudo nötig
- **background**: Sofortiger detached Start, gibt Handle `bg_[hex]` zurück
- **yieldMs**: Auto-Yield nach N ms (default 10000), Prozess läuft im Hintergrund weiter
- **process-Tool**: Management für Background-Prozesse (list, poll, kill, log, wait)

### MVP-Scope (was NICHT drin ist)
- Kein Path-Scoping / Workspace-Root Isolation
- Kein Security-Layer (No-Fly ist best-effort, kein Anti-Bypass)
- Kein Logger
- Keine Shell-Builtin-Commands außer Standard-Pipes/-Redirects

## Tools (Detailierte Docs)

Detaillierte Dokumentation für alle Tools liegt im `docs/tools/` Ordner:
- `exec.md` — Vollständige exec-Dokumentation
- `readFile.md` — Vollständige readFile-Dokumentation  
- `write.md` — write-Tool (atomares Write, Sensitive-Path-Block)
- `edit.md` — edit-Tool (Find-and-Replace, READ_REQUIRED)
- `process.md` — process-Tool (Background-Lifecycle)
- `file_state.md` — read-tracking für edit-Validation

## Daemon / Persistent Runtime Mode

**Files:** `src/daemon/` (types.ts, logger.ts, process.ts, ipc.ts, runtime.ts, commands.ts, systemd.ts)

### CLI Commands

```
harness daemon start     — Start daemon as detached background process
harness daemon stop      — Stop daemon (SIGTERM, then SIGKILL after 10s)
harness daemon restart   — Stop + start
harness daemon status     — Show PID, uptime, model, gateways, last errors
harness daemon install   — Generate and install systemd user service unit
harness daemon run       — Internal: run the daemon process (spawned by `start`)
harness reload-config    — Hot-reload daemon config without restart
```

### Config

Daemon config is an optional `"daemon"` key inside the existing `config.json`:

```json
{
  "models": [...],
  "providers": {...},
  "defaultModel": {...},
  "daemon": {
    "gateways": [],
    "skills": [],
    "memory": { "ambientHints": true, "maxHints": 5 },
    "logRetentionDays": 14,
    "heartbeatIntervalSec": 0
  }
}
```

**Hot-reloadable (via `harness reload-config`):** `memory.ambientHints`, `memory.maxHints`, `logRetentionDays`, `heartbeatIntervalSec`.

**Requires daemon restart:** `defaultModel`, `providers`, `models` (model list changes), adding/removing gateways.

### Logging

Structured JSON-lines logs go to `$HARNESS_STATE/logs/daemon-YYYY-MM-DD.log`. Daily rotation is implicit (new date → new file). Retention cleanup runs on init and on date-boundary crossings, deleting files older than `logRetentionDays`.

### IPC

CLI/TUI clients connect to the daemon via Unix socket at `$HARNESS_STATE/daemon.sock`. Wire protocol: newline-delimited JSON. Request types: `ping`, `status`, `submit-turn`, `reload-config`, `shutdown`.

### GatewayAdapter Interface

External transports (WhatsApp, etc.) implement:

```typescript
interface GatewayAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<boolean>;
  onInbound(handler: (message: InboundMessage) => void): void;
}
```

Adapters register via `DaemonRuntime.registerGateway()`. The WhatsApp/Baileys adapter docks here in the next goal.

### Heartbeat Hook

`DaemonRuntime.registerHeartbeat(hook)` accepts periodic health checks. The scheduler implementation comes with the cron/scheduler feature — this is only the mounting point.

### Metrics

New events in `system-*.jsonl` (type: `"daemon"`): `daemon_start`, `daemon_stop`, `daemon_crash_restart`, `config_reload`. Stale PID file detection on startup triggers `daemon_crash_restart`.

### systemd Deployment

`harness daemon install` writes `~/.config/systemd/user/harness-daemon.service` with `Restart=on-failure`, `RestartSec=5`, and `WantedBy=default.target`. Enable with:

```
systemctl --user daemon-reload
systemctl --user enable harness-daemon
systemctl --user start harness-daemon
```
