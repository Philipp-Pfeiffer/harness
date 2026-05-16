# Tools Documentation

## Implementierte Tools

| Tool | Phase | Datei | Beschreibung |
|------|-------|-------|--------------|
| [exec](exec.md) | Phase 1+2 | `src/tools/exec.ts` | CLI-Ausführung mit PTY, elevated, yieldMs, background |
| [process](process.md) | Phase 2 | `src/tools/process.ts` | Lifecycle-Management für Background-Prozesse |
| [readFile](readFile.md) | MVP | `src/tools/readFile.ts` | UTF-8 und PDF-Lesen |
| [write](write.md) | MVP | `src/tools/write_file.ts` | Atomares Write, Sensitive-Path-Block |
| [edit](edit.md) | MVP | `src/tools/edit_file.ts` | Find-and-Replace, READ_REQUIRED |

## Quick-Reference

### exec starten

```typescript
// Sync (normale Ausführung)
const result = await executeExec({ command: "echo hello" });

// Mit timeout
const result = await executeExec({ command: "sleep 5", timeout: 10000 });

// PTY für interaktive CLIs
const result = await executeExec({ command: "vim", pty: true });

// Elevated (sudo -n)
const result = await executeExec({ command: "id -u", elevated: true });

// Background (sofortiger Handle-Return)
const result = await executeExec({ command: "python -m http.server", background: true });
// → content: "Background process started.\nhandle: bg_a3f29c8d\n..."

// Auto-Yield nach 10s
const result = await executeExec({ command: "cargo build", yieldMs: 10000 });
// → Wenn Prozess nach 10s noch läuft: Handle zurück, Prozess im Hintergrund
```

### process-Tool

```typescript
// Alle Sessions auflisten
await processTool.execute({ action: "list" });

// Status einer Session
await processTool.execute({ action: "poll", sessionId: "bg_a3f29c8d" });

// Prozess beenden
await processTool.execute({ action: "kill", sessionId: "bg_a3f29c8d", signal: "SIGTERM" });

// Output-Log lesen (pagiert)
await processTool.execute({ action: "log", sessionId: "bg_a3f29c8d", offset: 0, limit: 16384 });

// Warten bis Exit
await processTool.execute({ action: "wait", sessionId: "bg_a3f29c8d", timeout: 30000 });
```

## No-Fly-List

Blockierte Commands (können nicht ausgeführt werden):

- `rm -rf`, `rm -fr`, `rm -Rf`, `rm -fR`
- `rm --recursive --force`
- `rm -r -f <path>`
- `dd if=<file>`
- `mkfs.*`
- `> /dev/sd*`, `> /dev/nvme*`, `> /dev/hd*`
- Fork bomb: `:( ){ :|:& };:`
- `shutdown`, `reboot`, `halt`, `poweroff`
- `kill -9 1`
- `chmod -R 0*0+ /`

**Erlaubt:** `rm /tmp/foo`, `rm file.txt`, `rm -i file.txt`

## Tool-Registry

```typescript
// src/tools/registry.ts
export function loadTools(): Tool[] {
  return [readFileTool, execTool, processTool, writeTool, editTool];
}
```

| Tool | Datei | Zweck (1 Satz) |
|------|-------|----------------|
| `readFile` | `src/tools/readFile.ts` | Liest UTF-8-Text und PDF; markiert Datei intern als gelesen. |
| `exec` | `src/tools/exec.ts` | Führt Shell-Commands aus (sync, PTY, elevated, background, yieldMs). |
| `process` | `src/tools/process.ts` | Verwaltet Background-Prozesse (list, poll, kill, log, wait). |
| `write` | `src/tools/write_file.ts` | Atomares Schreiben; blockt sensitive Pfade. |
| `edit` | `src/tools/edit_file.ts` | Sequentielles Find-and-Replace; erfordert vorheriges Read. |

## Output-Formate

### exec (Sync)

```
--- stdout ---
hello
--- stderr ---
(empty)
--- exit ---
code: 0, signal: null
```

### exec (PTY)

```
--- output ---
hello
--- exit ---
code: 0, signal: null
```

### exec (Background-Start)

```
Background process started.
handle: bg_a3f29c8d
pid: 12345
command: sleep 60
```

### exec (Timeout)

```
Command timed out after 30s and was terminated.
--- stdout ---
...
--- exit ---
code: 143, signal: null
```

### process list

```
--- running ---
handle: bg_a3f29c8d  pid: 12345  cmd: python -m http.server  started: 2026-04-26T13:30:12Z  age: 2m 15s
--- finished ---
handle: bg_5e1b0277  pid: -      cmd: npm run build          ended: 2026-04-26T13:32:45Z   exit: 0  age: 5s
```

### process poll

```
--- session bg_a3f29c8d ---
state: running
pid: 12345
command: python -m http.server
started: 2026-04-26T13:30:12Z
duration: 2m 30s
--- recent stdout (last 4 KB) ---
Serving HTTP on port 8000...
```
