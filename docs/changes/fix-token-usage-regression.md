# Fix: Token-Usage-Regression + Verifizierbarkeit

**Datum:** 2026-06-25  
**Branch:** `fix/token-usage-regression`  
**Ziel:** `/status`-Tokenwerte stimmen wieder, und der gesamte Token-Datenfluss ist an jeder Stufe nachprüfbar.

---

## 1. Root Cause

Die Regression war kein einzelner Bug, sondern ein **Drift zwischen vier Stufen des Token-Datenflusses**, der durch mehrere aufeinanderfolgende Commits entstanden ist.

| Stufe | Was ging schief | Eingeführt in | Fix-Commit |
|---|---|---|---|
| **1. Provider-Response** | pi-ai lieferte korrekte `Usage` mit `cacheRead`/`cacheWrite`, aber der Agent ignorierte die Cache-Felder. | `0f508f6` — `feat(core): token usage aggregation per session` | `2e43d7e` |
| **2. Agent-Result** | `TokenUsage` hatte nur `inputTokens`/`outputTokens`/`totalTokens`; `cacheRead`/`cacheWrite` fehlten. Dadurch war `input + output ≠ total`, sobald Prompt-Caching aktiv war. | `0f508f6` | `2e43d7e` |
| **3. Metrics-JSONL** | `TurnMetric` schrieb keine Cache-Felder; `App.tsx` übernahm sie nicht in `recordTurn()`. | `928092b` — `feat(metrics): add append-only JSONL tracking` | `2e43d7e` + `cc92852` |
| **4. /status-Reader** | `buildStatusSummary()` zeigte `tokensIn` nur als `inputTokens` an, ohne Cache. Zusätzlich wurde `toolCallCount` aus Loop-Iterationen statt echten Tool-Calls berechnet, und fehlgeschlagene Runs wurden doppelt gezählt (`error`- + `turn(status:error)`-Event). | `928092b`, `5a61431` | `2e43d7e`, `21fbff7`, `77f774c` |

### Schlüssel-Commits

- **Regressions-Commit (Stufe 2):** `0f508f6` — führte die kumulative Token-Aggregation ein, aber nur für `input`/`output`/`totalTokens`. Cache-Felder aus pi-ai `Usage` wurden verworfen.
- **Regressions-Commit (Stufe 3):** `928092b` — führte JSONL-Metriken ein, ohne Cache-Felder im Schema zu berücksichtigen.
- **Fix-Commits:**
  - `2e43d7e` — `fix(agent,metrics,status): track cacheRead/cacheWrite tokens`
  - `7e94f14` — `fix(agent,app): StatusBar shows per-call context fill instead of cumulative`
  - `21fbff7` — `fix(agent): real tool call counter instead of loop iterations`
  - `77f774c` — `fix(app): eliminate error double-counting in metrics`
  - `a8f1863` — `fix(app,metrics): add sessionId and label /status scope clearly`
  - `cc92852` — `fix(app): align sessionUsage type with cacheRead/cacheWrite fields`

---

## 2. Verifizierbarkeit: Token-Trace

Um künftige Drifts sofort sichtbar zu machen, wurde ein **Token-Trace** eingeführt.

### Aktivierung

```bash
HARNESS_TOKEN_TRACE=1 npm start
```

### Ausgabeformat (stderr, JSON, eine Zeile pro Stufe)

```json
[TOKEN-TRACE] {"stage":"provider-response","inputTokens":25,"outputTokens":20,"totalTokens":1545,"cacheRead":1500,"cacheWrite":0,"extra":{"turn":1,"model":"MiniMax-M2.7"}}
[TOKEN-TRACE] {"stage":"agent-result","inputTokens":25,"outputTokens":20,"totalTokens":1545,"cacheRead":1500,"cacheWrite":0,"extra":{"turn":1,"model":"MiniMax-M2.7"}}
[TOKEN-TRACE] {"stage":"metrics-jsonl","inputTokens":25,"outputTokens":20,"totalTokens":1545,"cacheRead":1500,"cacheWrite":0,"extra":{"sessionId":"...","status":"ok"}}
[TOKEN-TRACE] {"stage":"status-summary","inputTokens":1565,"outputTokens":70,"totalTokens":3135,"cacheRead":1500,"cacheWrite":0,"extra":{"toolCalls":1,"errors":0}}
```

### Implementierung

- `src/core/tokenTrace.ts` — zentrale Trace-Funktion, aktivierbar per `HARNESS_TOKEN_TRACE`.
- `src/core/agent.ts` — Trace an Stufe 1 (Provider-Response) und Stufe 2 (Agent-Result).
- `src/core/metrics.ts` — Trace an Stufe 3 (Metrics-JSONL).
- `src/core/statusSummary.ts` — Trace an Stufe 4 (/status-Reader).

---

## 3. Regressionstest

`tests/core/tokenFlow.test.ts` führt einen vollständigen Agent-Run mit gemocktem Provider durch und prüft, dass dieselben Token-Werte durch alle vier Stufen durchgereicht werden.

### Fixture

- **Turn 1 (toolUse):** `input=25`, `output=20`, `cacheRead=1500`, `cacheWrite=0`, `total=1545`
- **Turn 2 (stop):** `input=1540`, `output=50`, `cacheRead=0`, `cacheWrite=0`, `total=1590`
- **Erwartete Aggregate:** `inputTokens=1565`, `outputTokens=70`, `totalTokens=3135`, `cacheRead=1500`, `cacheWrite=0`

### Geprüfte Invarianten

1. Jede Provider-Response stimmt mit dem Fixture überein.
2. `AgentResult.usage` aggregiert die Fixture-Werte korrekt.
3. `readTodayMetrics()` liefert dieselben Werte wie `AgentResult.usage`.
4. `buildStatusSummary()` zeigt reale Werte (`tokensIn`, `tokensOut`, `sessionTokens` ≠ `n/a`).
5. `tokensIn` enthält Cache-Tokens: `1565 + 1500 + 0 = 3065` → `"3.1k"`.
6. Cache-Hit-Rate wird korrekt berechnet: `1500 / (1565 + 1500 + 0) ≈ 48.9%`.

### Ausführung

```bash
npx vitest run tests/core/tokenFlow.test.ts
```

---

## 4. Akzeptanzkriterien

- [x] `/status` zeigt nach echtem Agent-Run reale Tokenwerte (nicht `n/a`, nicht `0`).
- [x] `Provider-Usage == Agent-Result == JSONL == /status` für denselben Run.
- [x] Root Cause dokumentiert: Stufen 2 + 3, Commits `0f508f6` und `928092b`.
- [x] Regressionstest grün, der den Fluss end-to-end gegen ein Fixture prüft.
- [x] Token-Trace für manuelle Stufen-Überprüfung verfügbar.

---

## 5. Weitere geänderte Dateien

| Datei | Änderung |
|---|---|
| `src/core/tokenTrace.ts` | Neu: zentrale Token-Trace-Funktion |
| `src/core/agent.ts` | Trace an Stufe 1 + 2 |
| `src/core/metrics.ts` | Trace an Stufe 3 |
| `src/core/statusSummary.ts` | Trace an Stufe 4 |
| `tests/core/tokenFlow.test.ts` | Neu: End-to-End-Regressionstest |
| `tests/core/tokenTrace.test.ts` | Neu: Unit-Tests für Token-Trace |
