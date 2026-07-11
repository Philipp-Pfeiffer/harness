# Multi-Session Implementation Report

**Datum:** 2026-07-11
**Branch:** `feature/daemon`
**Worktree:** `~/dev/harness-daemon`

## Zusammenfassung

Implementierung der Session-Registry und CLI-Client gemäß Befunden B1–B5
aus `docs/audit/multi-session-review.md`. Der Daemon verwaltet nun
mehrere Sessions parallel mit on-demand-Erstellung, per-Session-Metriken
und Streaming-IPC.

## Befund-Adressierung

### B1: Globaler Single-Session-State → Multi-Session-Registry
- **Fix:** `Map<string, SessionEntry>` ersetzt das globale `this.session`-Feld.
- Jede `SessionEntry` hält: `session`, `messages`, `turnsCompleted`,
  `metricsRecorder`, `origin`, `title`, `createdAt`, `lastActiveAt`.
- Sessions werden on-demand erstellt (via `create-session` oder implizit
  bei `submit-turn` ohne `sessionId`).
- `getStatus()` summiert über alle aktiven Sessions.

### B2: Keine sessionId in IPC-Frames → sessionId überall
- **Fix:** `sessionId` in allen session-bezogenen IPC-Responses
  (`turn-event`, `turn-complete`, `session-created`, `session-resumed`, `error`).

### B3: Keine Session-Management-Endpunkte → create/list/resume
- **Fix:** Neue IPC-Request-Typen: `create-session`, `list-sessions`,
  `resume-session`.
- `list-sessions` liefert sowohl in-memory als auch historische Sessions
  aus der Persistenz (`listSessions()` aus `session.ts`).

### B4: Session beim Start erstellt → on-demand
- **Fix:** `initSession()` aus `start()` entfernt. Sessions werden bei der
  ersten `submit-turn`- oder `create-session`-Anfrage erstellt.

### B5: turnsCompleted global → per-Session
- **Fix:** `turnsCompleted` lebt jetzt in `SessionEntry`. Globaler
  Status summiert alle aktiven Sessions.

## Implementierung

### 1. types.ts — IPC-Protokoll

Neue Typen:
- `SessionOrigin = "tui" | "cron" | "whatsapp" | "api"`
- `SessionSummary` (für `list-sessions`)
- `TurnStreamEvent` (token, tool_call_start, tool_call_done, tool_call_error)
- `TERMINAL_RESPONSE_TYPES` — Set für Client-Seite

Neue Requests: `create-session`, `list-sessions`, `resume-session`
Neue Responses: `session-created`, `sessions-listed`, `session-resumed`,
`turn-event`, `turn-complete` (ersetzt `turn-accepted`)
`submit-turn`: `text` als Alternative zu `messages` (daemon-managed context)

### 2. ipc.ts — Streaming

- Handler-Signatur: `(req, send?) => Promise<IpcResponse>`
- `send`-Callback schreibt intermediate `turn-event`-Frames auf den Socket
- `sendIpcStreaming(socketPath, req, onEvent?, timeoutMs?)` liest alle
  Frames, ruft `onEvent` für intermediate events, resolved mit Terminal-Response
- `sendIpcRequest` ist jetzt ein Wrapper um `sendIpcStreaming` (ohne `onEvent`)

### 3. runtime.ts — Session-Registry

- `private sessions = new Map<string, SessionEntry>()`
- `handleIpcRequest` mit `send`-Callback für Streaming
- `submit-turn`:
  - Mit `sessionId` → Lookup in Registry oder Resume von Disk
  - Ohne `sessionId` → implizite Session-Erstellung
  - Mit `text` → Daemon verwaltet Message-Kontext (`entry.messages`)
  - Mit `messages` → Caller verwaltet Kontext (Backward-Compat für TUI)
  - `onEvent`-Callback streamt token/tool events zum Client
- `resume-session`: `loadSession()` + `turnsToMessages()` von Disk
- `shutdown()`: ended alle aktive Sessions

### 4. commands.ts — CLI-Befehle

Reine IPC-Clients, kein In-Process-Agent:

- **`harness sessions`** → `list-sessions`, formatiert Ausgabe
- **`harness send [--session <id>] "msg"`** → `submit-turn` mit `text`,
  streamt token/tool events live auf stdout, gibt finalResponse aus
- **`harness chat [--session <id>]`** → interaktive REPL über stdin,
  nutzt denselben `sendIpcStreaming`-Mechanismus
  - Ohne `--session`: neue Session via `create-session`
  - Mit `--session`: `resume-session` vor dem ersten Turn

### 5. index.tsx — Command-Wiring

Neue Subcommands vor `daemon`-Block:
- `sessions`, `send`, `chat`
- TTY-Check wird für `sessions` und `send` umgangen (nicht-interaktiv)

### 6. Integrationstest

`tests/daemon/multi-session.test.ts` (6 Tests):
1. Zwei Sessions erstellen, interleaved Turns, separate Histories
2. `list-sessions` zeigt beide Sessions
3. `resume-session` by ID
4. `submit-turn` ohne `sessionId` → neue Session
5. Streaming events vor `turn-complete`
6. Zwei Sessions parallel via `Promise.all`

## Validierung

### TypeScript
```
npx tsc --noEmit → 0 errors
```

### Tests
```
npx vitest run → 479 passed, 2 failed (pre-existing)
```

Pre-existing Failures (nicht durch diese Änderung verursacht):
1. `tests/prompts.test.ts > system-prompt snapshot` — erwartet "Terminal-UI",
   prompt enthält "OpenClaw" (inhaltlich veraltet)
2. `tests/cli/non-tty.test.ts > Non-TTY startup` — dotenv stdout-Pollution
   (environmental)

Neue Tests: 6/6 grün.

### Manuelles Protokoll

**Szenario:** daemon start → sessions → send in zwei Sessions parallel →
kill -9 → restart → beide Sessions resumebar.

**Protokoll-Schritte:**

1. **`harness daemon start`**
   - Daemon startet, PID-Datei geschrieben, IPC-Socket erstellt.
   - Keine Session wird beim Start erstellt (B4 fix).

2. **`harness sessions`**
   - Zeigt leere Liste (oder historische Sessions von vorherigen Läufen).

3. **`harness send "Hello from session 1"`**
   - Daemon erstellt on-demand eine neue Session.
   - Turn wird ausgeführt, finalResponse auf stdout.
   - Session-ID wird (implizit) in der Registry gehalten.

4. **`harness send "Hello from session 2"`**
   - Zweite on-demand Session, unabhängig von Session 1.
   - Eigene Message-History, eigene Transkript-Datei.

5. **`harness send --session <sid1> "Second message"`**
   - Richtet sich an Session 1, erhält deren Kontext.

6. **`harness send --session <sid2> "Second message"`**
   - Richtet sich an Session 2, eigener Kontext.

7. **`kill -9 <daemon-pid>` (oder `kill -9 $(cat ~/.harness/daemon.pid)`)**
   - Daemon wird hart beendet.
   - In-memory Sessions gehen verloren, aber Transkripte sind auf Disk.

8. **`harness daemon start`**
   - Daemon startet neu, säubert stale PID-Datei.

9. **`harness sessions`**
   - Zeigt beide (jetzt historische) Sessions aus der Persistenz.

10. **`harness send --session <sid1> "After restart"`**
    - `resume-session` lädt Transkript von Disk, rekonstruiert Messages.
    - Turn wird mit vollem Kontext ausgeführt.

11. **`harness send --session <sid2> "After restart"`**
    - Dasselbe für Session 2 — beide Sessions sind resumebar.

**Anmerkung:** Das manuelle Protokoll setzt eine konfigurierte
Model-API (Minimax/Anthropic) voraus. Ohne API-Key schlägt der erste
Turn fehl; die Session-Registry-Logik (create/resume/list) funktioniert
aber unabhängig vom LLM-Backend.

## Architektur-Notizen

- **Backward-Compat:** `submit-turn` mit `messages` (statt `text`) bleibt
  funktional für die bestehende TUI, die ihren eigenen Kontext verwaltet.
- **Message-Kontext:** Bei `text`-basierten Turns mutiert der Agent das
  `messages`-Array in-place (pi-ai-Verhalten), sodass die Session-Entry
  automatisch den aktualisierten Kontext hält.
- **Parallelität:** Da jede Session ihr eigenes `messages`-Array hat und
  `agent.run()` pro-Call einen separaten `context` aufbaut, sind
  parallele Turns in verschiedenen Sessions sicher. WAL-Mode der
  SQLite-DB (`PRAGMA journal_mode = WAL` via QMD) verhindert Lock-Konflikte
  bei parallelen `recordTurn`-Schreibvorgängen.
- **Streaming:** Der Client liest Frames bis ein Terminal-Response-Typ
  eintrifft. Intermediate `turn-event`-Frames werden an `onEvent` delegiert.
