# Fix: Status-Command & Token-Metriken

**Datum:** 2026-06-19
**Branch:** `fix/status-token-metrics`
**Basis:** `5385c08` (investigate/status-token-metrics)

## Übersicht

Implementiert Fixes für alle 6 Bugs aus der Root-Cause-Analyse
(`FINDINGS.md`) sowie zusätzliche Verbesserungen (Cache-Verifikation,
Cache-Hit-Rate, Formatierung). 10 Commits insgesamt.

## Commits

| # | Commit | Beschreibung |
|---|--------|--------------|
| 1 | `10e21de` | BUG 1: StatusBar zeigt Per-Call Context Fill statt kumulativ |
| 2 | `f91fd8a` | BUG 2: Cache-Tokens (cacheRead/cacheWrite) erfasst |
| 3 | `aeac391` | BUG 3: Error-Double-Counting beseitigt |
| 4 | `9f377bd` | BUG 4: Echter Tool-Call-Counter statt Loop-Iterationen |
| 5 | `c737c77` | BUG 5+6: sessionId + /status Scope-Labeling |
| 6 | `0ce7906` | Docs: FINDINGS.md + changes/fix-status-token-metrics.md |
| 7 | `3df99fa` | TypeScript fix: sessionUsage type aligned with cacheRead/cacheWrite |
| 8 | `cfa05a2` | formatTokens: M-Suffix für Millionen-Tokens |
| 9 | `3a30089` | Chore: Native module builds (better-sqlite3, node-pty, esbuild) |
| 10 | `64c5591` | Feature: Cache-Hit-Rate in /status anzeigen |

## Änderungen im Detail

### BUG 1: StatusBar Per-Call Context Fill (MAJOR)

**Problem:** StatusBar verglich kumulative Token-Summe mit Per-Call Context-Window-Limit.

**Fix:**
- `AgentEvent` "usage" trägt nun `callInputTokens`/`callOutputTokens`/`callTotalTokens` (Per-Call) neben kumulativen Werten.
- Neuer State `lastCallTokens` in App.tsx, gesetzt via usage-Event-Handler (ersetzt den absichtlich leeren Handler).
- StatusBar nutzt `lastCallTokens` für Context-Window-Ratio. Session-Gesamtverbrauch separat als "Ses: Xk" angezeigt.
- `/clear` resettet auch `lastCallTokens`.

**Tests angepasst:**
- `tests/cli/App.test.tsx`: "accumulates tokens" und "keeps counter across /model" erwarten jetzt `15 / 100.0k` (Per-Call) + `Ses: 30` statt `30 / 100.0k`.
- `tests/agent.test.ts`: Usage-Event-Assertions um `call*`-Felder erweitert.

### BUG 2: Cache-Tokens erfasst (MITTEL)

**Problem:** `cacheRead`/`cacheWrite` nicht in TokenUsage/TurnMetric erfasst → `in + out ≠ total`.

**Fix:**
- `TokenUsage` um `cacheRead`/`cacheWrite` erweitert.
- Agent akkumuliert `totalCacheRead`/`totalCacheWrite`.
- `TurnMetric` hat optionale `cacheRead`/`cacheWrite`-Felder.
- `readTodayMetrics()` summiert Cache-Felder.
- `buildStatusSummary()`: `tokensIn = input + cacheRead + cacheWrite` → `in + out == total`.

**Tests angepasst:**
- Alle RunResult-`toEqual` in `tests/agent.test.ts` um `cacheRead: 0, cacheWrite: 0` ergänzt (16 Stellen).
- `tests/core/statusSummary.test.ts`: JSONL-Testdaten um Cache-Felder ergänzt.
- `tests/core/metrics.test.ts`: `recordTurn`-Test prüft `cacheRead`/`cacheWrite`.
- `tests/cli/App.test.tsx`: Mock-RunResults um Cache-Felder ergänzt.

### BUG 3: Error-Double-Counting (MITTEL)

**Problem:** `.catch()`-Handler schrieb `recordError()` UND `recordTurn({status:"error"})` → 2 Errors für 1 Fehler.

**Fix:** `recordError()`-Aufruf im `.catch()`-Handler entfernt. Nur `recordTurn({status:"error"})` behalten.

**Tests:**
- Neuer Test in `statusSummary.test.ts`: "does not double-count agent-run errors" verifiziert 1 Error = 1 Count.

### BUG 4: Echter Tool-Call-Counter (NIEDRIG)

**Problem:** `toolCallCount` = `result.turns` (Loop-Iterationen), nicht echte Tool-Ausführungen.

**Fix:**
- Neue Variable `toolCallCount` in `agent.ts`, inkrementiert nur bei `tool.execute()`.
- `RunResult` trägt `toolCallCount` in beiden Union-Members.
- `App.tsx` nutzt `result.toolCallCount` für `recordTurn()`.

**Tests angepasst:**
- Alle 17 RunResult-`toEqual` in `tests/agent.test.ts` um `toolCallCount` ergänzt (Werte: 0–2 je nach Test).
- `tests/cli/App.test.tsx`: Mock-RunResults um `toolCallCount: 0` ergänzt.

### BUG 5+6: sessionId + /status Scope-Labeling (NIEDRIG)

**Problem:** Keine `sessionId` in JSONL. `/status` zeigte "Tokens today" ohne klare Abgrenzung zur StatusBar.

**Fix:**
- `App.tsx` generiert `sessionId = randomUUID()` und übergibt an `createMetricsRecorder({ sessionId })`.
- `StatusContext` hat `sessionId`-Feld.
- `StatusSummary` hat `sessionId` und `sessionTokens` Felder.
- `/status` zeigt: "Session ID: <uuid>", "Tokens today: X in / Y out", "Session: Zk".

**Tests angepasst:**
- `formatStatusSummary`-Test: 13 Zeilen (war 11).

## Geänderte Dateien

| Datei | Bugs/Features |
|---|---|
| `src/core/agent.ts` | 1, 2, 4 |
| `src/core/metrics.ts` | 2 |
| `src/core/statusSummary.ts` | 2, 5+6, formatTokens M, Cache-Hit-Rate |
| `src/cli/App.tsx` | 1, 2, 3, 4, 5+6, formatTokens M, TypeScript fix |
| `tests/agent.test.ts` | 1, 2, 4 |
| `tests/cli/App.test.tsx` | 1, 2, 4 |
| `tests/core/metrics.test.ts` | 2 |
| `tests/core/statusSummary.test.ts` | 2, 3, 5+6, Cache-Hit-Rate |
| `pnpm-workspace.yaml` | Native module build approval |

## Zusätzliche Verbesserungen (nach BUG 1–6)

### TypeScript Type Fix (`3df99fa`)

`sessionUsage`-State-Typ in App.tsx fehlten `cacheRead`/`cacheWrite`-Felder,
die in BUG 2 zu `TokenUsage` und `StatusContext` hinzugefügt wurden.
`setSessionUsage`-Akkumulation um Cache-Felder ergänzt.

### formatTokens M-Suffix (`cfa05a2`)

`formatTokens()` in `statusSummary.ts` und `App.tsx` erweitert:
- `< 1000` → Rohzahl
- `< 1M` → `X.Xk` (z.B. `75.9k`)
- `≥ 1M` → `X.XM` (z.B. `4.6M` statt `4589.9k`)

### Native Module Builds (`3a30089`)

`pnpm-workspace.yaml`: `allowBuilds`-Platzhalter durch `true`/`false`
ersetzt. `better-sqlite3`, `node-pty`, `esbuild` werden jetzt gebaut.

### Cache-Hit-Rate Feature (`64c5591`)

`/status` zeigt eine `Cache hit:`-Zeile mit der täglichen Cache-Hit-Rate:
- Formel: `cacheRead / (input + cacheRead + cacheWrite)` als Prozentwert
- Nenner = 0 → `n/a` (keine Crash, kein NaN)
- Tests: 6 neue Tests (Hit-Rate-Berechnung, n/a-Fall, 0.0%-Fall,
  Mehr-Turn-Aggregation, Input-Token-Nenner, formatierter Output)

## Tests

```
npx vitest run tests/agent.test.ts tests/cli/App.test.tsx tests/core/metrics.test.ts tests/core/statusSummary.test.ts tests/cli/statusCommand.test.tsx
→ 124 tests passed (0 failed)
```

Pre-existing failures (7 test files: tools/*, non-tty) sind nicht durch diese Änderungen verursacht und existieren auf der Basis-Commit ebenfalls.

## Akzeptanzkriterien

- ✅ StatusBar nach Turn 2: `15 / 100.0k` (Per-Call), nicht `30 / 100.0k` (kumulativ)
- ✅ `/status`: `in + out == total` (cacheRead in tokensIn einberechnet)
- ✅ 1 fehlgeschlagener Run → `/status` zeigt errors: 1
- ✅ `toolCallCount` = echte Tool-Ausführungen
- ✅ Alle JSONL-Entries haben `sessionId`
- ✅ Prompt-Caching bei MiniMax bestätigt (cacheRead=152, cacheWrite=219 im Echtlauf)
- ✅ Cache-Hit-Rate in `/status`: `Cache hit: 41.0%`
- ✅ formatTokens zeigt `M`-Suffix ab 1M Tokens
- ✅ TypeScript compiliert sauber (`tsc --noEmit`)
