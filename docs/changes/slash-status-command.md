# Change: `/status` Slash-Command

## Übersicht

`/status` ist ein **lokaler TUI-Slash-Command**, der eine kompakte Statuszusammenfassung im Chat-/Output-Bereich rendert.

**Kein Terminal-Command.** `harness status` existiert nicht und wurde nicht implementiert.

## Verhalten

Wenn der User `/status` in der Harness-TUI eingibt:

- **Kein LLM-Call** — wird lokal abgefangen, bevor der Agent gestartet wird.
- **Keine Tool-Calls** — keine Tool-Ausführung.
- **Kein Agent-Run** — `agent.run()` wird nicht aufgerufen.
- Statusausgabe wird als Completed-Turn in den Chat-Stream eingefügt.

## Angezeigte Daten

| Feld | Quelle | Fallback |
|------|--------|----------|
| Session | Runtime (`isRunningRef`) | `ready` |
| Model | `activeModel.id` | `n/a` |
| Workspace | `process.cwd()` | `n/a` |
| Memory | `!memoryService?.degraded` | `n/a` |
| Tokens today | JSONL-Metrics → Session-Usage | `n/a` |
| Tool calls | JSONL-Metrics → Context | `0` |
| Errors today | JSONL-Metrics → Context | `0` |
| Last turn | JSONL-Metrics (`latencyMs`) | `n/a` |
| Metrics | `~/.harness/metrics/` Pfad (Override via `HARNESS_METRICS_DIR`) | — |

## Metrics-Reader

`src/core/statusSummary.ts` enthält `readTodayMetrics()`:

- Liest die heutigen JSONL-Dateien aus dem Metrics-Verzeichnis:
  - `turns-YYYY-MM-DD.jsonl` → Turn-Events (Tokens, Latenz, Status)
  - `tools-YYYY-MM-DD.jsonl` → Tool-Call-Events
  - `system-YYYY-MM-DD.jsonl` → Error-Events
- Summiert `inputTokens`, `outputTokens`, `totalTokens` aus Turn-Events
- Zählt Tool-Call-Events als `toolCalls`
- Zählt Fehler aus `error`-Events, fehlgeschlagenen Tool-Calls und fehlgeschlagenen Turns als `errors`
- Letzte Turn-Latenz wird als `lastTurnLatencyMs` gespeichert
- Verzeichnis-Override via `HARNESS_METRICS_DIR` Umgebungsvariable
- **Robust:** fehlende Dateien → `null`, kaputte JSON-Zeilen → übersprungen

Wenn Metrics noch nicht existieren, degradiert die Ausgabe sauber zu `n/a` bzw. zu Session-Werten.

## Beispielausgabe

```
Harness Status
──────────────
Session:      ready
Model:        minimax-m2.7
Workspace:    /home/user/dev/harness
Memory:       ready
Tokens today: 12.4k in / 3.1k out
Tool calls:   18 today
Errors today: 0
Last turn:    8.4s
Metrics:      ~/.harness/metrics/
```

## Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `src/core/statusSummary.ts` | **Neu** — Types, Metrics-Reader, Builder, Formatter |
| `src/cli/statusCommand.ts` | **Neu** — `isStatusCommand()`, `handleStatusCommand()` |
| `src/cli/commands.ts` | `/status` zur Autocomplete-Liste hinzugefügt |
| `src/cli/App.tsx` | `/status` in `handleSubmit` abgefangen |
| `tests/core/statusSummary.test.ts` | **Neu** — 20 Tests |
| `tests/cli/statusCommand.test.tsx` | **Neu** — 10 Tests |
| `docs/changes/slash-status-command.md` | **Neu** — dieser Change-Report |

## Tests

- `tests/core/statusSummary.test.ts` — Metrics-Reader (fehlt, summiert, kaputte Zeilen, partiell, leer), Builder (Fallbacks, Präferenz Metrics > Session), Formatter (Labels, Kompaktheit)
- `tests/cli/statusCommand.test.tsx` — `isStatusCommand` Erkennung, `handleStatusCommand` ohne LLM, TUI-Integration (kein `mockRun`-Aufruf, Autocomplete-Picker)

## Non-Goals

Nicht implementiert:

- ❌ Kein Terminal-Command `harness status`
- ❌ Kein Web Dashboard
- ❌ Kein Daemon Healthcheck
- ❌ Kein Cron
- ❌ Kein Session Resume
- ❌ Kein Full Session Browser
- ❌ Kein Memory-Rebuild
- ❌ Keine neuen Tools
- ❌ Kein LLM-Call für Status
- ❌ Keine Shell-Ausführung für Status
