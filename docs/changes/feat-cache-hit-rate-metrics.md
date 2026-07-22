# feat: Cache Hit Rate pro Tag in /status anzeigen

## Problem

Der `/status`-Befehl sollte die Cache Hit Rate des aktuellen Tages anzeigen. Die Anzeige-Logik (`formatCacheHitRate`, `readTodayMetrics`, `formatStatusSummary` in `statusSummary.ts`) war bereits implementiert, aber die Cache Hit Rate zeigte immer "n/a".

**Ursache:** Der Agent-Loop (`agent.ts`) rief `metricsRecorder?.recordToolCall()` auf, aber niemals `metricsRecorder?.recordTurn()`. Dadurch wurden keine Turn-Metriken (inkl. `cacheRead`, `cacheWrite`, `inputTokens`, `outputTokens`) in die täglichen JSONL-Metrikkdateien geschrieben. Die Funktion `readTodayMetrics()` in `statusSummary.ts` fand keine Turn-Einträge und konnte keine Cache Hit Rate berechnen.

## Befund

- `MetricsRecorder.recordTurn()` war in `metrics.ts` definiert und ready, aber wurde im Agent-Loop nie aufgerufen.
- `statusSummary.ts` hatte bereits die vollständige Anzeige-Logik inkl. `formatCacheHitRate()`: `cacheRead / (inputTokens + cacheRead + cacheWrite) * 100`.
- Der fehlende Schritt war ausschließlich das Aufrufen von `recordTurn()` an den Exit-Punkten des Agent-Loops.

## Was geändert wurde

**Datei:** `packages/core/src/core/agent.ts`

1. **`providerStartMs`-Timer** hinzugefügt vor der Stream-Erstellung, um die Latenz eines Turns zu messen.

2. **`metricsRecorder?.recordTurn()`-Aufrufe** an allen Exit-Punkten des Agent-Loops:
   - **error:** Turn mit Provider-Fehler → `status: "error"`
   - **aborted (vor Tools):** Signal-Abbruch nach Provider-Antwort, vor Tool-Ausführung → `status: "aborted"`
   - **aborted (nach Tools):** Signal-Abbruch nach Tool-Ausführung → `status: "aborted"` (mit `toolCallCount`)
   - **ok (nach Tools):** Turn mit Tool-Verwendung → `status: "ok"` (mit `toolCallCount`)
   - **stop/length:** Turn endet mit finaler Antwort → `status: "ok"`
   - **aborted (Provider):** Provider bricht selbst ab → `status: "aborted"`
   - **maxTurns:** Maximale Iterationen erreicht → `status: "aborted"` (keine Provider-Antwort, Null-Tokens)

Jeder `recordTurn`-Aufruf übergibt: `latencyMs`, `toolCallCount`, `status`, `model`, `inputTokens`, `outputTokens`, `totalTokens`, `cacheRead`, `cacheWrite` aus der jeweiligen Provider-Antwort.

## Welche Tests

Alle 683 bestehenden Tests bleiben grün (`npx vitest run`). Die Änderung fügt Metrik-Aufrufe hinzu, die fire-and-forget sind (`void appendMetric`), daher sind keine Test-Änderungen nötig.
