# Tool: process

**Status:** Implementiert (Phase 2)
**Datei:** `src/tools/process.ts`
**Zusammenarbeit:** `processSupervisor.ts`

## Überblick

Das `process`-Tool verwaltet Background-Prozesse, die mit `exec({background: true})` oder via `yieldMs` gestartet wurden. Es bietet Lifecycle-Management: List, Poll, Kill, Log, Wait.

## Parameter

| Parameter | Typ | Pflicht | Default | Beschreibung |
|-----------|-----|---------|---------|--------------|
| `action` | `"list" \| "poll" \| "kill" \| "log" \| "wait"` | Ja | — | Die Action |
| `sessionId` | `string` | Nein* | — | Handle im Format `bg_[a-f0-9]{8}` |
| `signal` | `"SIGTERM" \| "SIGKILL" \| "SIGINT"` | Nein | `SIGTERM` | Signal für kill |
| `offset` | `integer` | Nein | `0` | Byte-Offset für log |
| `limit` | `integer` | Nein | `16384` | Max Bytes für log |
| `timeout` | `integer` | Nein | `30000` | Timeout für wait (ms) |

*sessionId ist required für alle Actions außer `list`.

## Actions

### list

Gibt alle Sessions aus (running + finished).

```
--- running ---
handle: bg_a3f29c8d  pid: 12345  cmd: python -m http.server  started: 2026-04-26T13:30:12Z  age: 2m 15s
--- finished ---
handle: bg_5e1b0277  pid: -      cmd: npm run build          ended: 2026-04-26T13:32:45Z   exit: 0  age: 5s
```

### poll

Gibt Status einer spezifischen Session zurück.

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

### kill

Sendet Signal und wartet auf Exit.

```
--- killed bg_a3f29c8d ---
signal sent: SIGTERM
exit code: 143
exit signal: SIGTERM
```

### log

Paginierter Output-Log.

```
--- log bg_a3f29c8d ---
offset: 0  limit: 16384  total_bytes: 45000  truncated: true
--- stdout ---
<bytes [offset, offset+limit)>
--- stderr ---
<bytes [offset, offset+limit)>
```

### wait

Blockiert bis Prozess endet oder Timeout.

```
--- session bg_a3f29c8d ---
state: finished
pid: 12345
command: python -m http.server
started: 2026-04-26T13:30:12Z
ended: 2026-04-26T13:32:45Z
duration: 2m 33s
exit code: 0
exit signal: null
--- stdout ---
<full output>
--- stderr ---
<full output>
```

Oder bei Timeout (Prozess noch running):

```
--- session bg_a3f29c8d ---
state: running
pid: 12345
command: sleep 60
started: 2026-04-26T13:30:12Z
duration: 35s
still running (timeout after 30000ms)
```

## Session-Lookup

`sessionId` wird direkt als Key in der `sessions` Map gesucht. Kein Fallback, keine gemischte Suche.

## Signal-Handling bei kill

1. `SIGTERM` senden
2. 5s grace period warten
3. Falls Prozess noch läuft → `SIGKILL` senden
4. Exit-Code und Signal zurückgeben

## Validation-Errors

| Case | Output |
|------|--------|
| `poll` ohne sessionId | `sessionId required for poll` |
| `kill` ohne sessionId | `sessionId required for kill` |
| `log` ohne sessionId | `sessionId required for log` |
| `wait` ohne sessionId | `sessionId required for wait` |
| Ungültiges sessionId-Pattern | `Invalid arguments: ...` |
| Session nicht gefunden | `Session <handle> not found or expired.` |

## Nicht enthalten (Future)

- `process({action: "write"})` für stdin-Streaming an laufende Prozesse
- `process({action: "list", filter})` für gefilterte Listen
- `process({action: "log", follow})` für Streaming-Follow-Mode
