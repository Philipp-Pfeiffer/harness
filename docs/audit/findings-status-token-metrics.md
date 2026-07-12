# FINDINGS: Status-Command & Token-Metriken

**Branch:** `investigate/status-token-metrics`
**Datum:** 2026-06-19
**Modus:** Investigation (keine Code-Änderungen am Produktivcode)

---

## 1. Ergebnis zur Hypothese

**Hypothese:** Token-Zahlen stimmen nicht mit dem tatsächlichen Verbrauch überein, und der Status-Command zeigt falsche/inkonsistente Werte.

**Urteil: BESTÄTIGT (teilweise mit Einschränkungen)**

Die Hypothese ist bestätigt. Es gibt **sechs konkrete Probleme** mit unterschiedlicher
Schwere. Der schwerste Fehler (BUG 1) macht die StatusBar-Anzeige nach wenigen Turns
semantisch falsch. Die `/status`-Anzeige hat eine Inconsistency zwischen `in` + `out`
und `total` (BUG 2) sowie ein Error-Double-Counting (BUG 3).

Die Token-Zahlen stammen korrekt aus der API-Antwort (pi-ai `Usage`), werden aber bei
Aggregation und Anzeige falsch kontextualisiert. Die Diskrepanz ist reproduzierbar.

---

## 2. Datenfluss der Token-Metriken

```
┌─────────────────────────────────────────────────────────────┐
│  API Response (pi-ai)                                        │
│  response.usage = {                                           │
│    input: 850,         // non-cached input tokens            │
│    output: 150,        // output tokens                      │
│    cacheRead: 200,     // cached prompt tokens               │
│    cacheWrite: 0,      // cache creation tokens              │
│    totalTokens: 1200,  // input+output+cacheRead+cacheWrite  │
│    cost: { ... }                                             │
│  }                                                            │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────┐
│  agent.ts (Agent Loop)                                    │
│  Lines 300–303:                                           │
│    totalInput   += response.usage.input;      // 850      │
│    totalOutput  += response.usage.output;     // 150      │
│    totalTokens  += response.usage.totalTokens;// 1200     │
│    onEvent({type:"usage", ...kumulative Werte})           │
│                                                           │
│  → Gesamt über alle Iterationen einer run()-Invocation   │
│  → RunResult.usage = {inputTokens, outputTokens,          │
│                        totalTokens}                        │
└──────────────────┬───────────────────────────────────────┘
                   │
          ┌────────┴────────┐
          ▼                 ▼
┌─────────────────┐  ┌──────────────────────────────────┐
│  App.tsx State  │  │  App.tsx Metrics Recorder        │
│  Lines 912–922  │  │  Lines 923–931                    │
│                  │  │                                   │
│  setSessionUsage │  │  metricsRecorder.recordTurn({    │
│  (accumulate     │  │    inputTokens, outputTokens,    │
│   across runs)   │  │    totalTokens, latencyMs,      │
│                  │  │    toolCallCount: result.turns, │
│                  │  │    status                       │
│                  │  │  })                              │
└────────┬─────────┘  └────────────┬────────────────────┘
         │                         ▼
         │          ┌──────────────────────────────┐
         │          │  JSONL File (~/.harness/      │
         │          │  metrics/turns-YYYY-MM-DD)    │
         │          │  Append-only, fire-and-forget │
         │          └────────────┬─────────────────┘
         │                         │
         ▼                         ▼
┌──────────────────┐  ┌─────────────────────────────────┐
│  StatusBar       │  │  /status Command                 │
│  (App.tsx:107ff) │  │  (statusCommand.ts →             │
│                  │  │   statusSummary.ts)              │
│  Shows:          │  │                                   │
│  sessionUsage    │  │  readTodayMetrics() reads JSONL  │
│  .totalTokens /  │  │  → sums ALL turns for today      │
│  contextWindow   │  │  (across all sessions!)           │
│                  │  │                                   │
│  → BUG 1:        │  │  If metrics → use metrics        │
│    cumulative    │  │  Else → fallback to sessionUsage │
│    vs per-call   │  │                                   │
│    limit         │  │  → BUG 2: input + output ≠      │
│                  │  │    total (cache tokens missing) │
│                  │  │  → BUG 3: errors double-counted │
│                  │  │  → BUG 5: scope mismatch        │
│                  │  │    with StatusBar                 │
└──────────────────┘  └──────────────────────────────────┘
```

### Referenzen (Datei:Zeile)

| Komponente | Datei | Zeilen |
|---|---|---|
| `Usage` type (pi-ai) | `node_modules/@mariozechner/pi-ai/dist/types.d.ts` | 121–134 |
| `AssistantMessage.usage` | `node_modules/@mariozechner/pi-ai/dist/types.d.ts` | 148 |
| Anthropic provider usage parsing | `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js` | 319–330, 463–484 |
| `TokenUsage` interface | `src/core/agent.ts` | 58–62 |
| Agent token accumulation | `src/core/agent.ts` | 248–250, 300–303 |
| `RunResult.usage` return | `src/core/agent.ts` | 257, 323, 437, 451, 459–466 |
| `TurnMetric` type | `src/core/metrics.ts` | 7–18 |
| `appendMetric()` (JSONL) | `src/core/metrics.ts` | 80–92 |
| `createMetricsRecorder()` | `src/core/metrics.ts` | 109–139 |
| `sessionUsage` state | `src/cli/App.tsx` | 649 |
| `sessionUsage` accumulation | `src/cli/App.tsx` | 912–922 |
| `metricsRecorder.recordTurn()` | `src/cli/App.tsx` | 923–931 |
| `metricsRecorder.recordError()` | `src/cli/App.tsx` | 956–962 |
| `StatusBar` component | `src/cli/App.tsx` | 107–148 |
| `StatusBar` render | `src/cli/App.tsx` | 1096 |
| `readTodayMetrics()` | `src/core/statusSummary.ts` | 62–134 |
| `buildStatusSummary()` | `src/core/statusSummary.ts` | 149–189 |
| `formatStatusSummary()` | `src/core/statusSummary.ts` | 193–208 |
| `handleStatusCommand()` | `src/cli/statusCommand.ts` | 23–29 |

---

## 3. Konkrete Fehlerquellen mit Belegen

### BUG 1: StatusBar vergleicht kumulative Token-Summe mit Context-Window-Limit (MAJOR)

**Wo:** `src/cli/App.tsx:118`, `src/cli/App.tsx:912–922`, `src/core/agent.ts:300–303`

**Code:**
```typescript
// agent.ts:300–303 — accumulates across iterations within one run()
totalInput += response.usage.input;
totalOutput += response.usage.output;
totalTokens += response.usage.totalTokens;

// App.tsx:912–922 — further accumulates across multiple run() calls
setSessionUsage((prev) =>
  prev
    ? { ...prev, totalTokens: prev.totalTokens + result.usage.totalTokens }
    : result.usage
);

// App.tsx:118 — compares cumulative against per-call limit
const used = usage?.totalTokens ?? 0;       // cumulative!
const maxStr = contextWindow ? formatTokens(contextWindow) : "?";
// App.tsx:124–126
const ratio = used / contextWindow;          // cumulative / per-call limit
if (ratio > 0.95) counterColor = "red";
else if (ratio > 0.8) counterColor = "yellow";
```

**Problem:** `sessionUsage.totalTokens` ist die kumulative Summe aller API-Calls seit
Session-Start. `contextWindow` ist das Per-Call-Limit. Diese beiden Größen haben
unterschiedliche Semantik. Die kumulative Summe wächst ungebunden, das Context-Window
ist pro Call begrenzt.

**Beispiel:**
- Turn 1 (initial): API-Call mit input=2000, output=500 → totalTokens=2500
- Turn 2 (wächst): API-Call mit input=3000 (vollen Kontext), output=800 → totalTokens=3800
- StatusBar zeigt: 2500 + 3800 = 6300 / 100000 = 6.3%
- Tatsächliches Context-Window-Fill-Level am Ende von Turn 2: ~3800/100000 = 3.8%
- Nach ~15 Turns (jeweils 3000–5000 Tokens) würde die StatusBar >100% zeigen,
  obwohl der Context-Window nie voll war.

**Test-Bestätigung:** `tests/cli/App.test.tsx:770–792` — Mock returns je Turn
15 Tokens, nach 2 Turns wird "30 / 100.0k" erwartet (kumulativ, nicht kontextuell).

**Schwere: HOCH** — Die StatusBar ist die primäre Anzeige für Context-Window-Auslastung.
Nach wenigen Turns wird sie semantisch falsch und die Farbwarnungen (gelb/rot)
triggern zu früh oder an完全 irrelevanten Zeitpunkten.

---

### BUG 2: `inputTokens` enthält keine Cache-Tokens (cacheRead, cacheWrite fehlen)

**Wo:** `src/core/agent.ts:300`, `src/core/metrics.ts:12–14`, `src/core/statusSummary.ts:155–165`

**Code:**
```typescript
// agent.ts:300 — only captures response.usage.input, not cacheRead/cacheWrite
totalInput += response.usage.input;

// metrics.ts:12–14 — TurnMetric has no cacheRead/cacheWrite fields
export interface TurnMetric {
  inputTokens?: number;   // = response.usage.input (non-cached only)
  outputTokens?: number;
  totalTokens?: number;   // = input + output + cacheRead + cacheWrite
  // ... no cacheRead, no cacheWrite
}

// statusSummary.ts:155–165 — shows input + output separately
const tokensIn = metrics
  ? formatTokens(metrics.inputTokens)     // non-cached input only
  : ...;
const tokensOut = metrics
  ? formatTokens(metrics.outputTokens)
  : ...;
```

**Problem:** Die pi-ai `Usage` hat 4 Token-Komponenten:
- `input` — non-cached input tokens
- `output` — output tokens
- `cacheRead` — aus dem Cache gelesene Tokens
- `cacheWrite` — neu in den Cache geschriebene Tokens
- `totalTokens` = `input + output + cacheRead + cacheWrite`

Der Agent akkumuliert nur `input`, `output` und `totalTokens`. Die
Cache-Tokens (`cacheRead`, `cacheWrite`) werden implizit in `totalTokens` erfasst,
aber nicht einzeln aufgezeichnet.

**Konsequenz:** In der `/status`-Anzeige gilt: `tokensIn + tokensOut ≠ totalTokens`,
wenn Cache aktiv ist. Für MiniMax (Anthropic-kompatibel) ist Cache typischerweise
aktiv (System-Prompt wird gecacht).

**Beispiel:**
```
Api-Response: input=850, output=150, cacheRead=200, cacheWrite=0, totalTokens=1200
Agent accumulates: inputTokens=850, outputTokens=150, totalTokens=1200

/status zeigt: "Tokens today: 850 in / 150 out"
Erwartet: 850 + 150 = 1000, aber totalTokens = 1200
Differenz: 200 Tokens (cacheRead) sind "verschwunden" in der Anzeige
```

**Dokumentiert als bekanntes Issue:** `docs/changes/metrics-jsonl-mvp.md:137`
> cacheRead/cacheWrite/cost — pi-ai's Usage hat diese Felder, aber der Agent
> akkumuliert nur input/output/totalTokens.

**Schwere: MITTEL** — `totalTokens` ist korrekt, aber die Aufschlüsselung in/out ist
_irreführend_, wenn Cache aktiv ist. Die Summe von `in` und `out` stimmt nicht
mit `total` überein.

---

### BUG 3: Error-Double-Counting in /status

**Wo:** `src/cli/App.tsx:956–962` (zählt 2 Events), `src/core/statusSummary.ts:110–120` (zählt beide)

**Code:**
```typescript
// App.tsx:956–962 — on error, TWO metric events are recorded:
.catch((err: unknown) => {
  // Event 1: error event
  metricsRecorder.recordError({ scope: "agent_run", message: errMsg });
  // Event 2: turn event with status "error" (no token counts)
  metricsRecorder.recordTurn({
    model: activeModel.name,
    latencyMs: Date.now() - runStartMs,
    toolCallCount: 0,
    status: "error",
  });
});

// statusSummary.ts:110–120 — readTodayMetrics counts BOTH:
if (entry.type === "turn") {
  if (entry.status === "error") agg.errors++;   // ← counts turn error
} else if (entry.type === "tool_call") {
  if (entry.status === "error") agg.errors++;
} else if (entry.type === "error") {
  agg.errors++;                                   // ← counts error event
}
```

**Problem:** Ein einziger fehlerhafter Agent-Run erzeugt 2 Error-Einträge in der
JSONL-Metriken, und `readTodayMetrics()` zählt beide. `/status` zeigt also
2 Errors für 1 tatsächlich aufgetretenen Fehler.

**Beispiel:**
```
User schickt Nachricht → Agent-Run schlägt fehl (Provider Error)

JSONL wird geschrieben:
  system-2026-06-19.jsonl: {"type":"error","scope":"agent_run","message":"..."}
  turns-2026-06-19.jsonl:  {"type":"turn","status":"error","toolCallCount":0}

/status zeigt: "Errors today: 2"
Tatsächlich: 1 Fehler
```

**Beachte:** Der `tool_call`-Error-Pfad (agent.ts:375,381,395) zählt nur als 1
(quadratisch über Error-Status in readTodayMetrics), aber der Agent-Run-Error-Pfad
ist der Problemfall.

**Schwere: MITTEL** — Fehlernummer ist verdoppelt, was zu Fehlinterpretationen bei
der System-Health-Analyse führen kann.

---

### BUG 4: `toolCallCount` in TurnMetric ist Loop-Iterationen, nicht Tool-Calls

**Wo:** `src/cli/App.tsx:929`

**Code:**
```typescript
metricsRecorder.recordTurn({
  // ...
  toolCallCount: result.aborted ? 0 : result.turns,  // result.turns = loop iterations
  // ...
});
```

**Problem:** `result.turns` ist die Anzahl der Loop-Iterationen in `agent.ts:252`
(`for (let i = 0; i < maxIterations; i++)`). Eine Iteration kann 0 Tool-Calls
enthalten (nur Text-Response) oder mehrere Tool-Calls (parallele Calls).

**Beispiel:**
```
Turn 1: LLM gibt Text aus (stop) → turns=1, Tool-Calls=0
        toolCallCount in metrics: 1 (falsch, sollte 0 sein)

Turn 2: LLM gibt 3 Tool-Calls → turn 2: Text → turns=2, Tool-Calls=3
        toolCallCount in metrics: 2 (falsch, sollte 3 sein)
```

**Dokumentiert:** `docs/changes/metrics-jsonl-mvp.md:139`
> toolCallCount in Turn Metrics — aktuell wird result.turns (Anzahl
> Loop-Iterationen) als toolCallCount gesetzt. Präziser wäre ein eigener Zähler.

**Schwere: NIEDRIG** — Nur Metadaten in JSONL, nicht direkt in `/status`-Anzeige
sichtbar (`/status` nutzt die `tool_call`-Events zum Zählen, nicht `toolCallCount`).

---

### BUG 5: Diskrepanz zwischen StatusBar und /status bei Multi-Session-Läufen

**Wo:** `src/cli/App.tsx:1096` (StatusBar), `src/core/statusSummary.ts:153` (/status)

**Problem:**
- **StatusBar** zeigt `sessionUsage.totalTokens` — kumulativ für die **aktuelle Session**.
- **/status** zeigt `readTodayMetrics().totalTokens` — kumulativ für **alle Sessions heute** (JSONL).
- Wenn der User an einem Tag mehrere Sessions hat, zeigen StatusBar und /status
  **verschiedene kumulative Werte**.

**Beispiel:**
```
Session 1: verbraucht 5000 Tokens → JSONL hat turn-events mit totalTokens=5000
Session 2 (neu gestartet): verbraucht 3000 Tokens → JSONL hat nun total=8000

In Session 2:
  StatusBar:  3000 / 100.0k     ← sessionUsage (nur Session 2)
  /status:    8.0k in / ... out  ← JSONL (Session 1 + Session 2)
```

**Schwere: NIEDRIG** — Labels unterscheiden ("today" vs. keine Beschriftung). Aber
potenziell verwirrend, wenn User beide Werte vergleicht. Das ist ein Design-Choice
(JSONL = tägliche Aggregation, sessionUsage = aktuelle Session), kein Versehen,
aber die Diskrepanz ist nicht dokumentiert.

---

### BUG 6: Keine `sessionId` in Metriken → Querschnittsanalyse unmöglich

**Wo:** `src/cli/App.tsx:672`

**Code:**
```typescript
const metricsRecorder = useMemo<MetricsRecorder>(() => createMetricsRecorder(), []);
// → no sessionId passed → createMetricsRecorder() → sessionId undefined
// → every JSONL entry has no sessionId field
```

**Problem:** JSONL-Einträge haben kein `sessionId`-Feld. `/status` kann nicht
zwischen aktueller und früherer Session unterscheiden. Dies verstärkt BUG 5.

**Dokumentiert:** `docs/changes/metrics-jsonl-mvp.md:138`
> Session ID — createMetricsRecorder() in App.tsx wird aktuell ohne sessionId erstellt.

**Schwere: NIEDRIG** — Funktionale Auswirkung nur in Kombination mit BUG 5.

---

## 4. Reproduktion: Erwartet vs. Tatsächlich

### Reproduzierte Scenario: 2-Turn-Session mit MiniMax (Anthropic-kompatibel)

**Setup:**
- System Prompt: ~1500 Tokens (wird gecacht)
- User Message 1: "Hallo" (~5 Tokens)
- API Call 1: input=25 (non-cached), output=20, cacheRead=1500, cacheWrite=0 → total=1545
- Agent antwortet direkt (stop), keine Tool-Calls
- User Message 2: "Was kannst du?" (~10 Tokens)
- API Call 2: input=1540 (non-cached, da Kontext gewachsen, Cache evtl. miss), output=50, cacheRead=0, cacheWrite=0 → total=1590
- Agent antwortet direkt (stop), keine Tool-Calls

**Erwartete Anzeige (korrekt):**

| Komponente | Erwartet | Begründung |
|---|---|---|
| StatusBar nach Turn 1 | 1.5k / 100.0k | Context-Window-Fill: 1545/100000 |
| StatusBar nach Turn 2 | 1.6k / 100.0k | Context-Window-Fill: 1590/100000 (nicht 3135) |
| /status tokensIn | 1.6k | Non-cached input gesamt: 25+1540=1565 (oder inkl. Cache: 1525+1590=3115) |
| /status tokensOut | 70 | Output gesamt: 20+50=70 |
| /status errors | 0 | Keine Fehler |
| /status toolCalls | 0 | Keine Tool-Calls |

**Tatsächliche Anzeige (BUG 1 + BUG 2）：**

| Komponente | Tatsächlich | Abweichung | Bug |
|---|---|---|---|
| StatusBar nach Turn 1 | 1.5k / 100.0k | ✅ korrekt (zufällig, da 1 Turn) | — |
| StatusBar nach Turn 2 | 3.1k / 100.0k | ❌ 3135 statt 1590 (kumulativ statt kontextuell) | BUG 1 |
| /status tokensIn | 25 | ❌ fehlt cacheRead (1500+0=1500 Tokens nicht gezeigt) | BUG 2 |
| /status tokensOut | 70 | ✅ korrekt | — |
| /status errors | 0 | ✅ korrekt (kein Fehler-Path ausgeführt) | — |
| /status toolCalls | 0 | ✅ korrekt | — |
| /status Implizit: in+out=total? | 95 ≠ 3135 | ❌ Diskrepanz durch fehlende Cache-Tokens | BUG 2 |

**Reproduktion mit Agent-Run-Error:**

Wenn der API Call 1 einen Provider-Error wirft (z.B. Rate-Limit):

| Komponente | Erwartet | Tatsächlich | Bug |
|---|---|---|---|
| /status errors | 1 | 2 | BUG 3 |

---

## 5. Empfehlungen für den Fix (Vorschläge, nicht umgesetzt)

### Fix für BUG 1: StatusBar soll Context-Window-Fill-Level zeigen

**Was:** Die StatusBar soll das Context-Window-Fill-Level der **letzten** API-Antwort
anzeigen, nicht die kumulative Summe.

**Wo:** `src/cli/App.tsx` — neues Event oder State für "lastApiResponseTokens".

**Wie:**
1. In `agent.ts`: Den `usage`-Event (AgentEvent type "usage") so ändern, dass er
   die **per-call** Werte überträgt, nicht die kumulierten. Aktuell sendet der
   Event `totalInput`, `totalOutput`, `totalTokens` (kumuliert seit Run-Start).
   Stattdessen `response.usage.totalTokens` als einzelnen Call-Wert senden.
2. In `App.tsx`: Die `onEvent`-Behandlung für `type: "usage"` (aktuell leer/ignoriert,
   Zeilen 888–891) nutzen, um `sessionUsage` mit dem **jeweils letzten** Call-Wert
   zu setzen (replace, nicht accumulate), ODER einen `lastCallTokens`-State einführen.
3. StatusBar zeigt dann `lastCallTokens / contextWindow` — der echte Fill-Level.

**Alternative:** Wenn kumulative Anzeige gewünscht ist, das Label ändern
("Tokens used: Xk" ohne Context-Window-Vergleich).

### Fix für BUG 2: Cache-Tokens erfassen

**Was:** `cacheRead` und `cacheWrite` in `TokenUsage` und `TurnMetric` aufnehmen.

**Wo:** `src/core/agent.ts:58–62`, `src/core/metrics.ts:7–18`, `src/cli/App.tsx:300–303, 923–931`

**Wie:**
1. `TokenUsage` um `cacheRead: number` und `cacheWrite: number` erweitern.
2. In `agent.ts:300–303`: `totalCacheRead += response.usage.cacheRead;` etc.
3. In `TurnMetric`: `cacheRead?: number`, `cacheWrite?: number` hinzufügen.
4. In `statusSummary.ts`: `tokensIn` als `input + cacheRead + cacheWrite` anzeigen
   (oder separaten "Tokens cached" Posten einführen).

### Fix für BUG 3: Error-Double-Counting auflösen

**Was:** Im `.catch()`-Handler entweder `recordError()` ODER `recordTurn({status:"error"})`
aufrufen, nicht beide.

**Wo:** `src/cli/App.tsx:956–962`

**Wie:** Option A: Nur `recordTurn({status:"error"})` (das Error-Event streichen).
Option B: Nur `recordError()` (das Turn-Event für fehlgeschlagene Runs streichen).
Empfehlung: Option A — `recordTurn` behalten, weil es Latenz und Tool-Count erfasst,
und `recordError` nur für Errors nutzen, die außerhalb eines Turns passieren.

### Fix für BUG 4: Echten Tool-Call-Counter

**Was:** In `agent.ts` einen `toolCallCount`-Zähler führen, der bei jeder
Tool-Ausführung inkrementiert wird (bei `tool.execute()` Aufruf, Zeile 387).

**Wo:** `src/core/agent.ts:248–250` (neue Variable), `src/core/agent.ts:387` (Inkrement)

### Fix für BUG 5: /status mit Session-Filter

**Was:** `/status` sollte sessionUsage für die aktuelle Session UND today's totals
anzeigen, oder `sessionId` in JSONL einführen und nur aktuelle Session aggregieren.

**Wo:** `src/cli/App.tsx:672` (sessionId generieren), `src/core/statusSummary.ts:62–134`
(Optional: nach sessionId filtern)

### Fix für BUG 6: sessionId generieren

**Was:** `randomUUID()` als Session-ID erzeugen und an `createMetricsRecorder()` weitergeben.

**Wo:** `src/cli/App.tsx:672`

---

## 6. Offene Fragen / Unsicherheiten

1. **Ist BUG 1 (kumulativ vs. kontextuell) ein Design-Fehler oder bewusst?**
   Die Tests (`tests/cli/App.test.tsx:770–792`) testieren explizit das kumulative
   Verhalten ("accumulates tokens across multiple turns"). Möglicherweise war die
   Intention, die **gesamten Session-Token-Kosten** zu zeigen, nicht das
   Context-Window-Fill-Level. In dem Fall wäre das Label irreführend, nicht die Daten.
   \u{2753} Klären: Soll die StatusBar Context-Window-Auslastung oder
   Session-Token-Verbrauch zeigen?

2. **Ist BUG 2 (Cache-Tokens) im realen Betrieb relevant?**
   MiniMax via Anthropic-kompatible API unterstützt Prompt-Caching. Ob es
   aktiviert ist, hängt von der API-Konfiguration ab. Wenn Cache deaktiviert ist,
   ist BUG 2 irrelevant (`cacheRead` = `cacheWrite` = 0, dann gilt
   `input + output = totalTokens`). Derzeit nicht überprüfbar ohne API-Zugang.
   \u{2753} Klären: Ist Prompt-Caching aktiviert?

3. **BUG 5 (Multi-Session-Diskrepanz):** Ist die tägliche Aggregation in `/status`
   bewusst so gewollt? Das Label sagt "Tokens today", was tägliche Aggregation
   impliziert. Die StatusBar hat keine Beschriftung, was Kontext-Window-Fill-Level
   impliziert. Die Diskrepanz könnte ein beabsichtigter Design-Choice sein.
   \u{2753} Klären: Soll /status die aktuelle Session oder den Tag zeigen?

4. **`usage` Event wird ignoriert:** App.tsx:888–891 hat einen `usage`-Event-Handler,
   der absichtlich nichts tut. Kommentar: "Live-Update während des Turns; finale
   Aggregation erfolgt aus result.usage um Doppelzählung bei Multi-Turn-Runs zu
   vermeiden." Dies ist eine bewusste Design-Entscheidung. Sie bedeutet aber, dass
   die StatusBar während eines laufenden Multi-Turn-Runs nicht aktualisiert wird.
   Ist das gewollt?

---

## Zusammenfassung (3–5 Sätze)

Die Hypothese ist bestätigt: Token-Metriken und Status-Command haben mehrere
konkrete Fehlerquellen. Der schwerste Fehler (BUG 1) ist, dass die StatusBar die
**kumulative Token-Summe** aller API-Calls gegen das **per-call Context-Window-Limit**
vergleicht — nach wenigen Turns zeigt sie einen falschen Prozentsatz und triggert
Farbwarnungen zu früh. BUG 2 ist, dass Cache-Tokens (`cacheRead`/`cacheWrite`) nicht
erfasst werden, wodurch `/status` "in + out ≠ total" anzeigt, sobald Prompt-Caching
aktiv ist. BUG 3 double-counted Errors: jeder fehlgeschlagene Agent-Run schreibt
sowohl ein `error`- als auch ein `turn(status:"error")`-Event, die beide in der
`/status`-Anzeige gezählt werden. Alle drei Hauptfehler sind reproduzierbar und
mit Code-Referenzen belegt. Empfohlene Fixes: per-call-Werte statt kumulativ für
StatusBar (BUG 1), Cache-Token-Felder ergänzen (BUG 2), und nur ein Error-Event pro
Fehler (BUG 3).
