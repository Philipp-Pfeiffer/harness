# Tool: exec

**Status:** Implementiert (Phase 1 + Phase 2)
**Datei:** `src/tools/exec.ts`
**Zusammenarbeit:** `execPty.ts`, `execBackground.ts`, `processSupervisor.ts`, `ringBuffer.ts`

## Überblick

Das `exec`-Tool ist das primäre CLI-Ausführungs-Tool. Es kann beliebige Shell-Commands ausführen — synchron, mit PTY, mit elevated Rechten, und im Hintergrund mit Lifecycle-Management.

## Parameter

| Parameter | Typ | Pflicht | Default | Beschreibung |
|-----------|-----|---------|---------|--------------|
| `command` | `string` | Ja | — | CLI-Command. Pipes, Redirects, Globs unterstützt. |
| `cwd` | `string` | Nein | `process.cwd()` | Working Directory. `~` wird expandiert. |
| `env` | `Record<string,string>` | Nein | — | Environment-Variablen. Werden auf `process.env` gemergt. |
| `stdin` | `string` | Nein | — | Input-Stream. Einmalig geschrieben, dann geschlossen. |
| `timeout` | `integer` | Nein | `30000` | Timeout in ms. Nach Ablauf: SIGTERM → 5s grace → SIGKILL. |
| `pty` | `boolean` | Nein | `false` | PTY-Modus für interaktive CLIs (vim, htop, etc.). |
| `elevated` | `boolean` | Nein | `false` | Prefix mit `sudo -n`. Passwordless sudo nötig. |
| `background` | `boolean` | Nein | `false` | Sofortiger Background-Start. Gibt Handle zurück. |
| `yieldMs` | `integer` | Nein | `10000` | Wartezeit bis Auto-Yield. Prozess läuft weiter im Hintergrund. |

## Execution-Branches

```
executeExec(args)
  ├─ args.background === true  → executeExecBackground()
  ├─ args.yieldMs > 0           → yield-Übergang (nach yieldMs → Background)
  ├─ args.pty === true          → executeExecPty()
  └─ else                      → executeExecSync()
```

## No-Fly-List (Blockierte Commands)

Folgende Patterns werden blockiert:

| Pattern | Reason | Hint |
|---------|--------|------|
| `rm -rf`, `rm -fr`, `rm -Rf`, `rm -fR` | rm with -rf/-fr/-Rf is blocked | Use 'trash' (trash-cli) |
| `rm --recursive --force` | same | same |
| `rm -r -f` (separate flags) | same | same |
| `dd if=<file>` | dd with input file blocked (disk destruction) | — |
| `mkfs.*` | mkfs.* blocked (filesystem format) | — |
| `> /dev/sd*` | Direct write to disk device blocked | — |
| `:( ){ :\|:& };:` | Fork bomb pattern blocked | — |
| `shutdown`, `reboot`, `halt`, `poweroff` | System power command blocked | — |
| `kill -9 1` | Killing init (PID 1) blocked | — |
| `chmod -R 0*0+ /` | Recursive chmod 000 on root blocked | — |

**Hinweis:** `rm` ohne destruktive Flags (z.B. `rm /tmp/foo`) ist **erlaubt**.

## Output-Formate

### Sync / PTY (normales Ergebnis)

```
--- stdout ---
<output>
--- stderr ---
<error output>
--- exit ---
code: 0, signal: null
```

### PTY (einzelner Stream)

```
--- output ---
<merged stdout+stderr>
--- exit ---
code: 0, signal: null
```

### Timeout

```
Command timed out after 30s and was terminated.
--- stdout ---
...
--- stderr ---
...
--- exit ---
code: 143, signal: null
```

### Background-Start

```
Background process started.
handle: bg_a3f29c8d
pid: 12345
command: sleep 60
```

## Cross-Field-Validation

| Kombination | Verhalten |
|------------|-----------|
| `pty: true` + `stdin` | Error: "stdin not supported with pty in Phase 1" |
| `background: true` + `stdin` | Error: "stdin not supported with background in Phase 2" |

## Phase 1 Features

- **Sync Execution:** `spawn()` mit `shell: true`, Output in Buffern gesammelt
- **cwd:** Path-Resolution mit `~` Expansion und Directory-Validation
- **env:** Merged auf `process.env`
- **stdin:** Einmaliges Write + End
- **timeout:** Konfigurierbar, mit TERM→GRACE→KILL (5s grace)
- **PTY-Mode:** `node-pty` Spawn, ANSI preserved, stdout/stderr merged
- **Elevated:** Prefix `sudo -n`, Exit-Code 1 wenn kein passwordless sudo

## Phase 2 Features

### yieldMs (Auto-Yield nach 10s default)

1. Prozess starten, Output in temporären Buffern sammeln
2. yieldMs-Timer starten
3. Wenn Prozess vor Timer endet → Sync-Output wie Phase 1
4. Wenn Timer vor Prozess-Ende abläuft:
   - Handle generieren (`bg_` + 8-char hex)
   - RingBuffer erstellen, bisherigen Output transferieren
   - Session beim ProcessSupervisor registrieren
   - Handle zurückgeben, Prozess läuft im Hintergrund weiter

### background: true (sofortiger Background)

- Spawn mit `detached: true`
- Sofort Handle generieren + registrieren
- Kein await, Handle sofort zurück

### process-Tool (Lifecycle)

Mit `process({action: ...})` können Background-Prozesse verwaltet werden:

| Action | Parameter | Beschreibung |
|--------|-----------|--------------|
| `list` | — | Listet alle Sessions (running + finished) |
| `poll` | `sessionId` | Status + letztem 4KB Output |
| `kill` | `sessionId`, `signal?` | SIGTERM → 5s grace → SIGKILL |
| `log` | `sessionId`, `offset?`, `limit?` | Paginated Output-Log |
| `wait` | `sessionId`, `timeout?` | Blockiert bis Exit oder Timeout |

## RingBuffer

- **Größe:** 200 KB pro Stream (stdout/stderr)
- **Behavior:** Append-only, wrap-around bei Overflow
- **totalBytesEverWritten:** Trackt alle je geschriebenen Bytes (für truncation-Info)
- **read(offset, limit):** Liest Bytes [offset, offset+limit); 返回 "bereits verworfen" wenn offset < oldestReadableOffset

## GC (Garbage Collection)

- **Intervall:** Alle 5 Minuten
- **Expiry:** Finished Sessions älter als 30 Minuten werden entfernt
- **Shutdown:** `processSupervisor.destroy()` sendet SIGTERM an alle laufenden Prozesse, nach 2s SIGKILL

## Error-Cases

| Case | Output |
|------|--------|
| cwd existiert nicht | `cwd does not exist or is not a directory` |
| No-Fly-Pattern matcht | `Blocked destructive command: <reason>. <hint>` |
| Spawn fehlschlägt | `Failed to spawn: <error message>` |
| Validation Error | `Invalid arguments: <validation errors>` |
| Prozess-Fehler | `Process error: <error message>` |

## Tests

| Test-Datei | Tests | Was getestet |
|------------|-------|--------------|
| `exec.test.ts` | 37 | Sync execution, env, stdin, timeout, yield, elevated, background, no-fly |
| `execPty.test.ts` | 6 | PTY detection, output cap, timeout, kill behavior |
| `process.test.ts` | 11 | Lifecycle (poll, kill, stdout capture) |
| `ringBuffer.test.ts` | 11 | RingBuffer append, overflow, read with offset |

## Bugs (historisch)

- **execPty onData vs onExit Race:** `onExit` konnte vor letztem `onData` Handler aufgerufen werden. Fix: `setImmediate(resolveOutput)` im Exit-Handler.
- **rm No-Fly zu aggressiv:** Altes Pattern matchte auch `rm /tmp/foo`. Fix: Lookahead-Pattern das nur bei `-rf`, `-fr`, `--recursive --force` etc. matcht.

## Nicht enthalten (Future)

- Live-PTY-Input (Multi-Roundtrip interaktive Sessions)
- Output-File-Spill (>200KB auf Tempfile)
- ANSI-Strip-Toggle
- Persistenz (Checkpoint-File)
- stdin-Streaming (statt einmaliges stdin-Argument)
- Workspace-Policy für cwd
