# Metrics & Token Tracking MVP

**Datum:** 2026-06-18  
**Branch:** `feat/metrics-jsonl-mvp`  
**Worktree:** `harness-metrics` (separat vom Haupt-Working-Tree)

## Was wurde implementiert

Append-only Metrics-Tracking in JSONL-Dateien. Drei Event-Typen werden an zentralen Stellen aufgezeichnet:

- **Turn Metrics** — nach jedem `agent.run()` Completion (in `App.tsx`)
- **Tool Call Metrics** — an der zentralen Tool-Ausführungsstelle im Agent Loop (`agent.ts`)
- **Error Metrics** — bei unbehandelten Fehlern im `.catch()` Handler der Agent-Run-Pipeline (`App.tsx`)

## Speicherort

```
~/.harness/metrics/
├── turns-YYYY-MM-DD.jsonl
├── tools-YYYY-MM-DD.jsonl
└── system-YYYY-MM-DD.jsonl
```

- Folgt der bestehenden `~/.harness/` Konvention aus `config.ts`.
- Override via `HARNESS_METRICS_DIR` Umgebungsvariable (für Tests).
- Tagesrotation per UTC-Datum (`YYYY-MM-DD` aus ISO-Timestamp).

## Event-Typen

### Turn Metric (`turns-*.jsonl`)

```json
{"ts":"2026-06-18T18:45:00.000Z","type":"turn","model":"MiniMax-M2.7","inputTokens":1234,"outputTokens":567,"totalTokens":1801,"latencyMs":4210,"toolCallCount":2,"status":"ok"}
```

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `ts` | string | ja | ISO 8601 Timestamp |
| `type` | `"turn"` | ja | Event-Typ |
| `sessionId` | string | nein | Session ID, falls gesetzt |
| `model` | string | nein | Modellname |
| `inputTokens` | number | nein | Input-Token-Gesamt |
| `outputTokens` | number | nein | Output-Token-Gesamt |
| `totalTokens` | number | nein | Token-Gesamt |
| `latencyMs` | number | ja | Latenz in ms |
| `toolCallCount` | number | ja | Anzahl Tool-Calls im Turn |
| `status` | `"ok" \| "aborted" \| "error"` | ja | Turn-Status |

### Tool Call Metric (`tools-*.jsonl`)

```json
{"ts":"2026-06-18T18:45:02.000Z","type":"tool_call","tool":"read_file","latencyMs":120,"status":"ok"}
```

Bei Fehler:
```json
{"ts":"2026-06-18T18:45:02.000Z","type":"tool_call","tool":"exec","latencyMs":500,"status":"error","error":"Command timed out"}
```

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `ts` | string | ja | ISO 8601 Timestamp |
| `type` | `"tool_call"` | ja | Event-Typ |
| `sessionId` | string | nein | Session ID, falls gesetzt |
| `tool` | string | ja | Tool-Name |
| `latencyMs` | number | ja | Ausführungsdauer in ms |
| `status` | `"ok" \| "error"` | ja | Status |
| `error` | string | nein | Sanitized Error-Message (nur bei `status: "error"`) |

### Error Metric (`system-*.jsonl`)

```json
{"ts":"2026-06-18T18:46:00.000Z","type":"error","scope":"agent_run","message":"Provider error"}
```

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `ts` | string | ja | ISO 8601 Timestamp |
| `type` | `"error"` | ja | Event-Typ |
| `sessionId` | string | nein | Session ID, falls gesetzt |
| `scope` | string | ja | Fehler-Scope (z.B. `"agent_run"`) |
| `message` | string | ja | Sanitized Error-Message |

## Geänderte Dateien

| Datei | Änderung |
|-------|---------|
| `src/core/metrics.ts` | **Neu** — Metrics-Modul: Event-Typen, `resolveMetricsDir()`, `appendMetric()`, `createMetricsRecorder()` |
| `src/core/agent.ts` | `metricsRecorder` zu `RunOptions` hinzugefügt; Tool-Call-Metrics an zentraler Ausführungsstelle (mit Timing) |
| `src/cli/App.tsx` | `createMetricsRecorder()` erstellen; Turn-Metrics in `.then()`, Error-Metrics in `.catch()` |
| `tests/core/metrics.test.ts` | **Neu** — 18 Unit Tests für JSONL-Append, Directory-Creation, Robustness, Sanitization |
| `docs/changes/metrics-jsonl-mvp.md` | **Neu** — Dieser Change-Report |

## Architektur-Entscheidungen

1. **Fire-and-forget Writes** — `appendMetric()` ist `async` aber Recorder-Methoden sind `void` und nie `await`-ed. Metrics dürfen den User-Flow nie blockieren.
2. **Nie werfen** — Alle Fehler in `appendMetric()` werden geschluckt (best-effort). Write-Fehler crashen den Agent nicht.
3. **UTC-Tagesrotation** — Konsistent über Zeitzonen hinweg. Dateiname aus `ts.slice(0, 10)`.
4. **Keine sensiblen Daten** — Nur Tool-Name, Latenz, Status. Keine Tool-Args, keine vollständigen Prompts, keine vollständigen Error-Traces.
5. **Dependency-injectable** — `createMetricsRecorder({ dir, sessionId })` für Tests überschreibbar.

## Tests

```
tests/core/metrics.test.ts — 18 tests
```

Abgedeckt:
- ✅ Metrics-Verzeichnis wird erstellt
- ✅ `recordTurn` appended eine JSON-Zeile
- ✅ Mehrere Events append-only, keine Überschreibung
- ✅ Tagesdateiname korrekt (UTC)
- ✅ JSONL ist parsebar, eine Zeile pro Event
- ✅ Fehler beim Schreiben crashen nicht (read-only dir)
- ✅ Error Messages werden gespeichert
- ✅ Unicode funktioniert
- ✅ Undefined optionale Felder brechen JSON nicht
- ✅ `sessionId` wird gestanpt, wenn gesetzt
- ✅ `resolveMetricsDir` mit/ohne Env-Override

Gesamte Test-Suite: **326/326 Tests grün** (30 Test-Dateien).

## Non-Goals

- ❌ Web Dashboard
- ❌ Daemon
- ❌ Cron
- ❌ Session Resume
- ❌ Full Session Storage
- ❌ Cost-Berechnung
- ❌ Token-Schätzung (echte Usage aus pi-ai wird verwendet)
- ❌ Logging vollständiger Prompts oder Tool-Args
- ❌ Memory-Optimierungen

## Offene Follow-ups

- **`cacheRead`/`cacheWrite`/`cost`** — pi-ai's `Usage` hat diese Felder, aber der Agent akkumuliert nur `input`/`output`/`totalTokens`. Für Cost-Tracking müsste `TokenUsage` erweitert werden.
- **Session ID** — `createMetricsRecorder()` in `App.tsx` wird aktuell ohne `sessionId` erstellt. Eine Session-ID-Generierung (z.B. `randomUUID()` pro CLI-Session) könnte nachgereicht werden.
- **`toolCallCount` in Turn Metrics** — aktuell wird `result.turns` (Anzahl Loop-Iterationen) als `toolCallCount` gesetzt. Präziser wäre ein eigener Zähler, der nur tatsächliche Tool-Ausführungen zählt.
