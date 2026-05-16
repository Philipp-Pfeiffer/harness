# exec-Tool — Technical Architecture

**Status:** Implementiert (Phase 1 + Phase 2)
**Letzte Aktualisierung:** 2026-04-26
**Zusammenarbeit:** `exec.ts`, `execPty.ts`, `execBackground.ts`, `processSupervisor.ts`, `ringBuffer.ts`, `process.ts`

---

## Überblick

Das `exec`-Tool (ehemals `bash`) ist das primäre CLI-Ausführungs-Tool des Harness-Systems. Es führt beliebige Shell-Commands aus — synchron, mit PTY, mit elevated Rechten, und im Hintergrund mit Lifecycle-Management.

**Kern-Verantwortlichkeiten:**
- Command-Execution (spawn, PTY, detached)
- Output-Sammlung (stdout/stderr getrennt, 64KB cap)
- Timeout-Handling (SIGTERM → 5s grace → SIGKILL)
- No-Fly-List (blockiert destruktive Commands vor Ausführung)
- Background-Prozess-Management (yield, handle, polling)

---

## Architektur-Übersicht

```
execTool.execute(args)
    │
    ├─ Validation (Value.Check via typebox/value)
    │
    ├─ Cross-Field-Validation
    │   └─ pty + stdin → Error
    │   └─ background + stdin → Error
    │
    ├─ resolveCwd() — tilde expansion + directory validation
    │
    ├─ checkNoFly(command) — pattern matching gegen blockierte commands
    │
    └─ Routing:
           │
           ├─ background: true  → executeExecBackground()
           │                         └─ spawn(detached: true)
           │                         └─ RingBuffer(200KB)
           │                         └─ processSupervisor.register()
           │
           ├─ yieldMs > 0  ─┬─ pty: true  → executeExecPty({yieldMs})
           │                 └─ else       → executeExecSyncWithYield()
           │                         └─ spawn(detached: true)
           │                         └─ Timer(yieldMs)
           │                         └─ RingBuffer(200KB) auf session
           │                         └─ processSupervisor.register()
           │
           ├─ pty: true  → executeExecPty()
           │                └─ node-pty.spawn()
           │                └─ merged output stream
           │
           └─ else  → executeExecSync()
                          └─ spawn(detached: true)
                          └─ Buffer[] chunks
```

---

## Dateien und ihre Rollen

### `src/tools/exec.ts` — Haupt-Tool

**exports:**
- `ExecArgs` — TypeBox Schema für Tool-Parameter
- `EXEC_NO_FLY_PATTERNS` — Array of `{pattern, reason, hint}` für blockierte Commands
- `executeExec(args)` — Haupt-Routing-Funktion
- `executeExecSync(args)` — Phase 1 sync execution
- `executeExecSyncWithYield(args)` — Sync mit Auto-Yield
- `execTool` — Tool-Object für Registry

**Key Functions:**

```typescript
// Validation
Value.Check(ExecArgs, args)

// No-Fly Check
checkNoFly(command: string) → {blocked: true, message} | {blocked: false}

// Output Formatting
formatOutput(stdout, stderr, exitCode, signal, truncated?, originalSize?) → string

// cwd Resolution
resolveCwd(cwdArg?: string) → Promise<string> // oder Error-String
```

### `src/tools/execPty.ts` — PTY Execution

Nutzt `node-pty` für interaktive CLIs (vim, htop, claude, etc.).

**Besonderheiten:**
- stdout/stderr werden gemergt (PTY hat nur einen Stream)
- ANSI-Codes werden preserved
- `pty.onData()` callback für output collection
- `pty.onExit()` mit `setImmediate(resolveOutput)` gegen Race Condition

**Bug-Fix (historisch):**
```
Race: onExit konnte vor letztem onData aufgerufen werden.
Fix: setImmediate(resolveOutput) im Exit-Handler.
```

### `src/tools/execBackground.ts` — Background Spawn

Startet Prozess sofort im detached mode.

**Flow:**
1. `spawn(command, [], {detached: true, ...})`
2. RingBuffer für stdout/stderr anlegen
3. Session erstellen und bei `processSupervisor` registrieren
4. Handle sofort zurückgeben

### `src/tools/processSupervisor.ts` — Lifecycle Management

Singelton `processSupervisor` verwaltet alle Background-Sessions.

**Session-Struktur:**
```typescript
type Session = {
  handle: string;           // "bg_a3f29c8d"
  pid: number;
  command: string;
  startedAt: Date;
  exitedAt?: Date;
  exitCode?: number;
  exitSignal?: string;
  cwd: string;
  isPty: boolean;
  isElevated: boolean;
  child: spawn | IPty;
  stdoutRing: RingBuffer;
  stderrRing: RingBuffer;
}
```

**API:**
| Methode | Beschreibung |
|---------|--------------|
| `register(session)` | Session hinzufügen, Exit-Handler registrieren |
| `get(handle)` | Session per Handle holen |
| `list()` | `{running: Session[], finished: Session[]}` |
| `kill(handle, signal?)` | SIGTERM → 5s grace → SIGKILL |
| `pollOutput(handle, tailBytes?)` | Letzte N Bytes Output lesen |
| `log(handle, offset, limit)` | Paginiertes Output-Log |
| `wait(handle, timeoutMs)` | Blockiert bis Exit oder Timeout |
| `destroy()` | Alle Prozesse killen, GC stoppen |

**GC (Garbage Collection):**
- Intervall: Alle 5 Minuten
- Finished Sessions älter als 30 Minuten werden entfernt
- `destroy()` sendet SIGTERM an alle, nach 2s SIGKILL

### `src/tools/ringBuffer.ts` — Append-Only Buffer mit Wrap-Around

**Warum RingBuffer?**
- Background-Prozesse können lange laufen und viel Output produzieren
- Wir wollen aber nur die letzten N Bytes behalten
- RingBuffer: Fixed-size, wrap-around, nie allokiert neu

**API:**
```typescript
append(chunk: Buffer)           // Hinzufügen, überschreibt alte Daten wenn voll
read(offset, limit) → {data, totalBytes, truncated}
getTotalBytes() → number        // Bytes die je geschrieben wurden (inkl. verworfene)
```

**Wichtig:** `read(offset, limit)` gibt leeren String zurück wenn `offset < droppedBytes`. Caller muss mit `truncated: true` umgehen.

### `src/tools/process.ts` — Tool für Background-Prozess-Management

Nutzt `processSupervisor` für Lifecycle-Commands.

**Parameter:**
```typescript
{ action: "list" | "poll" | "kill" | "log" | "wait", sessionId?, signal?, offset?, limit?, timeout? }
```

---

## No-Fly-List — Blockierte Commands

**WICHTIG:** Dies ist **Best-Effort**, kein Security-Layer. Es verhindert versehentliche Destruktion, nicht böswillige Umgehungsversuche.

### Aktuelle Patterns

```typescript
// rm -rf /-Varianten (ABER NICHT "rm /tmp/foo")
/\brm\b(?=\s+(--recursive\s+--force|--force\s+--recursive|-rf\b|-fr\b|-Rf\b|-fR\b|-[a-zA-Z]*[rR][a-zA-Z]*\s+-[a-zA-Z]*[fF]|-[a-zA-Z]*[fF][a-zA-Z]*\s+-[a-zA-Z]*[rR]))/

// dd mit input file
/\bdd\s+if=/

// mkfs任意
/\bmkfs\b/

// Direkte Disk-Geräte
/>\s*\/dev\/(sd|nvme|hd)/

// Fork Bomb
/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;:\s*:/

// System Power Commands
/\b(shutdown|reboot|halt|poweroff)\b/

// Kill init
/\bkill\s+-(9|KILL)\s+1\b/

// Recursive chmod 000 on root
/\bchmod\s+-R\s+0*0+\s+\//
```

### rm-Pattern Erklärung (historischer Bug-Fix)

Das ursprüngliche Pattern `/\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s)/` war zu aggressiv — es matchte auch `rm /tmp/foo`.

**Lösung:** Lookahead-Pattern das nur bei spezifischen gefährlichen Kombinationen matcht:
- `-rf`, `-fr`, `-Rf`, `-fR` (kombiniert)
- `--recursive --force` (separate flags)
- `-r -f` (mitWhitespace dazwischen)

**Erlaubt:** `rm /tmp/foo`, `rm file.txt`, `rm -i file.txt`

---

## Execution-Modi im Detail

### Phase 1: Sync Execution

```typescript
executeExecSync({
  command: "echo hello",
  cwd?: string,
  env?: Record<string,string>,
  stdin?: string,
  timeout?: number,
  elevated?: boolean
})
```

**Flow:**
1. Validation
2. No-Fly Check
3. `spawn(command, [], {shell: true, detached:true, cwd, env})`
4. stdout/stderr auf Buffer-Arrays sammeln
5. Timeout setzen (SIGTERM → 5s → SIGKILL)
6. `child.on("exit")` → Promise resolves

**Output-Format:**
```
--- stdout ---
<output>
--- stderr ---
<error>
--- exit ---
code: 0, signal: null
```

### Phase 1: PTY Mode

```typescript
executeExecPty({command, cwd?, env?, timeout?, elevated?, yieldMs?})
```

**Unterschiede zu Sync:**
- Nutzt `node-pty.spawn("bash", ["-c", command])`
- Nur ein output-Stream (stdout+stderr gemergt)
- ANSI-Codes preserved
- `--- output ---` statt `--- stdout --- / --- stderr ---`

### Phase 2: Auto-Yield (yieldMs)

```typescript
executeExecSyncWithYield({
  command: "cargo build",
  yieldMs: 10000  // Default: 10000
})
```

**Flow:**
1. Prozess starten
2. Output in temp Buffer-Arrays sammeln
3. yieldMs-Timer starten
4. Wenn Prozess vor Timer endet → Sync-Output zurück
5. Wenn Timer vor Prozess endet:
   - RingBuffer erstellen
   - Bisherigen Output transferieren
   - Session registrieren
   - Handle `bg_xxxxxxxx` zurückgeben

**Handle-Format:** `bg_${randomBytes(4).toString("hex")}`

### Phase 2: Background (background: true)

```typescript
executeExecBackground({command, cwd?, env?, elevated?})
```

**Unterschied zu yield:**
- Kein Timer — sofort im Background
- Kein transitionaler State — direkt Handle zurück
- Output geht direkt in RingBuffer

---

## Output-Cap und Truncation

### Grenzen

| Stream | Cap |
|--------|-----|
| Sync stdout+stderr combined | 64 KB |
| Sync stdout (einzeln) | 64 KB (kombiniert) |
| Sync stderr (einzeln) | 64 KB (kombiniert) |
| RingBuffer (pro Stream) | 200 KB |
| PTY output (kombiniert) | 200 KB |

### Truncation-Marker

Wenn Output gekürzt wird:
```
[...truncated, original size approx X bytes]
```

### Truncation-Logic

```typescript
// In executeExecSync:
if (stdoutSize + stderrSize + chunkSize > MAX_OUTPUT_BYTES) {
  const remaining = MAX_OUTPUT_BYTES - (stdoutSize + stderrSize);
  if (remaining > 0) {
    // Nur remainder aufnehmen
  }
  truncated = true;
}
```

---

## Timeout-Handling

### Flow

```
timeoutMs (default: 30000)
    │
    ├─ Timer startet
    │
    ├─ Prozess endet vor Timer → normal exit
    │
    └─ Timer läuft ab:
           │
           ├─ process.kill(-pid, "SIGTERM")
           │
           ├─ 5s grace period
           │
           └─ Falls noch alive:
                  └─ process.kill(-pid, "SIGKILL")
```

**Wichtig:** `detached: true` + Process-Group (`-pid`) stellt sicher, dass auch Sub-Prozesse (bei Pipes) gekillt werden.

---

## Validation-Fehler

### TypeBox Validation

```typescript
if (!Value.Check(ExecArgs, args)) {
  const errors = Array.from(Value.Errors(ExecArgs, args));
  const msg = errors.map(e => `${e.instancePath}: ${e.message}`).join("; ");
  return {isError: true, content: `Invalid arguments: ${msg}`};
}
```

### Error-Cases

| Case | Response |
|------|----------|
| `command: ""` (empty) | `Invalid arguments: /command: must not have fewer than 1 characters` |
| `timeout: 50` (< 100ms) | `Invalid arguments: /timeout: must be >= 100` |
| `timeout: 4000000` (> 1h) | `Invalid arguments: /timeout: must be <= 3600000` |
| `cwd` existiert nicht | `cwd does not exist or is not a directory` |
| No-Fly match | `Blocked destructive command: <reason>. <hint>` |
| `pty + stdin` | `stdin not supported with pty in Phase 1` |
| `background + stdin` | `stdin not supported with background in Phase 2` |
| Spawn failure | `Failed to spawn: <error message>` |
| Process error | `Process error: <error message>` |

---

## Testing

### Test-Dateien

| Datei | Tests | Abdeckung |
|-------|-------|-----------|
| `exec.test.ts` | 37 | Sync, env, stdin, timeout, yield, elevated, background, no-fly |
| `execPty.test.ts` | 6 | PTY detection, output cap, timeout, kill |
| `process.test.ts` | 12 | Lifecycle (poll, kill, stdout capture, >100 KB buffer) |
| `ringBuffer.test.ts` | 11 | RingBuffer append, overflow, read with offset |

### Test-Fixtures

- `tests/fixtures/file1.txt`, `file2.txt`, `file3.txt` — für glob-Tests
- `tests/fixtures/large.txt` — für >64KB Tests
- `tests/fixtures/sample.txt` — für readFile

### Wichtige Test-Cases

```typescript
// 1. Basic echo
await executeExec({command: "echo hello"})
→ stdout enthält "hello", exit 0

// 2. Non-zero exit
await executeExec({command: "exit 1"})
→ isError: false, content enthält "code: 1"

// 3. Separate stderr
await executeExec({command: "echo err >&2"})
→ stderr enthält "err"

// 4. Pipe chain
await executeExec({command: 'echo -e "a\\nb\\nc" | wc -l'})
→ stdout enthält "3"

// 5. Glob
await executeExec({command: "ls tests/fixtures/*.txt"})
→ stdout listet file1.txt, file2.txt, file3.txt

// 6. CWD
await executeExec({command: "pwd", cwd: "/tmp"})
→ stdout enthält "/tmp"

// 7. Invalid CWD
await executeExec({command: "pwd", cwd: "/nonexistent"})
→ isError: true, content enthält "cwd does not exist"

// 8. Output cap
await executeExec({command: "head -c 100000 /dev/urandom | base64"})
→ truncated: true, content enthält "[...truncated"

// 9. Timeout
const runShort = (args) => executeExec(args, 1000);
await runShort({command: "sleep 60"})
→ isError: true, content enthält "timed out"

// 10. No-Fly rm -rf
await executeExec({command: "rm -rf /tmp/test"})
→ isError: true, content enthält "Blocked destructive command"

// 11. No-Fly ERLAUBTES rm
await executeExec({command: "rm /tmp/foo"})
→ isError: false

// 12. Background start
await executeExec({command: "sleep 60", background: true})
→ content enthält "Background process started"
→ content enthält "handle: bg_..."

// 13. Yield transition
await executeExec({command: "sleep 5", yieldMs: 500})
→ Bei 5s: handle zurück, Prozess läuft weiter

// 14. Elevated (requires passwordless sudo)
await executeExec({command: "id -u", elevated: true})
→ code: 0 wenn sudo funktioniert, code: 1 wenn nicht
```

---

## TypeScript Strict Mode Considerations

### `child.pid` ist possibly undefined

```typescript
// Problem:
process.kill(-child.pid, "SIGTERM");
// Error: 'child.pid' is possibly 'undefined'

// Lösung:
if (child.pid) {
  process.kill(-child.pid, "SIGTERM");
}
```

### `spawn()` Return-Typ

```typescript
// Problem:
let child: ReturnType<typeof spawn> | null = null;

// Lösung (ohne null initialisierung):
let child: ReturnType<typeof spawn>;
try {
  child = spawn(...);
} catch (err) {
  return {isError: true, content: "Failed to spawn..."};
}
```

---

## Debugging

### Logs

Tool-Results werden in `logger` gekürzt geloggt:
```typescript
const truncated = result.length > 200 ? result.substring(0, 200) + "..." : result;
logger?.(`[TOOL CALL] ${toolCall.name}(${JSON.stringify(toolCall.arguments)}) → ${truncated}`);
```

### Häufige Probleme

**1. Prozess läuft nach Timeout weiter**
- Prüfe ob `detached: true` gesetzt ist
- Prüfe ob `process.kill(-pid, ...)` mit Minus für Process-Group

**2. Race: onExit vor letztem onData**
- Nutze `setImmediate(resolveOutput)` im Exit-Handler (execPty)

**3. RingBuffer liest offset < droppedBytes**
- `read()` gibt dann `{data: "", totalBytes, truncated: true}` zurück
- Caller muss prüfen ob `truncated === true`

**4. rm wird geblockt obwohl es harmlos ist**
- Pattern ist zu aggressiv bei rm
- Mit Lookahead-Pattern lösen (siehe No-Fly-List)

---

## Future Improvements (Nicht enthalten)

- Live-PTY-Input (Multi-Roundtrip interaktive Sessions)
- Output-File-Spill (>200KB auf Tempfile)
- ANSI-Strip-Toggle
- Persistenz (Checkpoint-File)
- stdin-Streaming (statt einmaliges stdin-Argument)
- Workspace-Policy für cwd
- `process({action: "write"})` für stdin an laufende Prozesse
- `process({action: "log", follow})` für Streaming-Follow-Mode
