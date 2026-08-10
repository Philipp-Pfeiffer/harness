# fix-abort-resilience

**Branch:** `fix/abort-resilience` (Worktree `~/dev/harness-abort-fix`)

## Problem

Der Agent-Turn wurde bisher in mehreren Szenarien hart beendet ("Aborted" auf WhatsApp), obwohl der Agent sich selbst recoverieren koennte:

| Abort-Typ | Symptom | Haeufigkeit (2026-08-09 Sessions) |
|-----------|---------|-----------------------------------|
| `maxTurns` | 10 Iterationen verbraucht, alle `toolUse` | 5/5 |
| `LLM-Error` (permanent/exhausted) | API-Fehler fuehrte zu `throw`, Turn beendet | 0/5 (Fix praeventiv) |
| `stopReason: "error"` | Provider meldet Fehler, Turn bricht ab | 0/5 (Fix praeventiv) |
| Crash im Agent-Loop | Unerwartete Exception, Turn crasht | 0/5 (Fix praeventiv) |

## Befund

### Forensik der 5 Aborts

**Session 20260809T090714-df1714:**
1. **Abort #1** (line 3): User "ich meinte du solltest das fuer dich eintragen..." -> Abort-restart waehrend der Agent kimi-Config suchte
2. **Abort #2** (line 12): Voice-Nachricht waehrend Transkription -> Abort-restart

**Session 20260809T151054-86b0d2:**
3. **Abort #3** (line 8): Instagram-Reel Download -> Browser-Agent verbrauchte 100 Turns, Main-Agent war bei Turn 9/10 und erschoepfte
4. **Abort #4** (line 14): User "das ist nicht der tracker.." -> Abort-restart waehrend Suche
5. **Abort #5** (line 34): "was gibts morgen mensa" -> 10 LLM-Calls alle `toolUse`, nie `stop`

### Code-Stellen

- `packages/core/src/core/agent.ts:985` -- `maxTurns` exhaustion -> `{ aborted: true }`
- `packages/core/src/core/agent.ts:642-650` -- permanent/retry-exhausted errors -> `throw err`
- `packages/core/src/core/agent.ts:714` -- `stopReason: "error"` -> `throw new Error(...)`
- `packages/agent/src/daemon/runtime.ts:1800` -- `result.aborted ? "Aborted"` (WhatsApp)
- `packages/agent/src/daemon/runtime.ts:639` -- gleiches bei post-restart-followup
- `packages/core/src/browser/runner.ts:282-283` -- `runResult.aborted && reason === "maxTurns"`
- `packages/core/src/core/agent.ts:172-174` -- `RunResult` Typ mit `reason: "maxTurns"`

## Fix

### 1. maxIterations 10 -> 100 (agent.ts)
`createAgent()` default von 10 auf 100. 10 war zu knapp fuer komplexe Tasks mit Browser-Sub-Agent.

### 2. Last-Turn-Warning (agent.ts)
Vor der letzten Iteration wird eine System-Message in den Message-History injiziert:
"Dies ist dein letzter Turn. Du MUSST jetzt eine finale Antwort schreiben -- keine Tool-Calls mehr."
Der Agent produziert dadurch natuerlicherweise `stopReason: "stop"` statt nochmal `toolUse`.

### 3. maxTurns -> aborted:false (agent.ts)
Wenn doch alle Iterationen verbraucht sind, wird nicht mehr `{ aborted: true }` zurueckgegeben, sondern `{ aborted: false, finalMessage: "Turn-Limit von 100 Iterationen erreicht." }`.

### 4. LLM-Fehler -> System-Message statt throw (agent.ts)
- **Permanent errors** (401, Auth, etc.): Injiziert `[SYSTEM] API call failed` -> naechster Turn
- **Exhausted retries**: Injiziert `[SYSTEM] API call failed after N retries` -> naechster Turn
- **stopReason: "error"**: Injiziert `[SYSTEM] Provider meldet Fehler` -> naechster Turn

### 5. Top-Level-Crash-Catch (agent.ts)
Gesamter `run()`-Body ist in `try/catch` gewrappt. Jede unerwartete Exception wird als `[SYSTEM] Interner Fehler` in den Context injiziert und der Turn endet mit `aborted: false`, `finalMessage` = Fehlertext.

### 6. WhatsApp "Aborted" entschaerft (runtime.ts)
`result.aborted ? "Aborted"` -> `result.aborted ? "[Turn aborted: ${result.reason}]"`
Da `aborted: true` kuenftig nur noch echte User-Aborts oder Gateway-Restarts sind, wird das kaum noch sichtbar sein.

### 7. Browser-Runner maxTurns-Check aktualisiert (runner.ts)
Der Check auf `runResult.aborted && runResult.reason === "maxTurns"` wurde durch `!runResult.aborted` ersetzt, da maxTurns nicht mehr `aborted: true` ist.

### 8. RunResult Type (agent.ts)
- `reason: "signal" | "maxTurns" | "internal_restart"` -> `reason: "signal" | "internal_restart"` (maxTurns ist kein Abort-Reason mehr)
- `error.type`: `"provider_aborted"` -> `"provider_aborted" | "max_turns_exhausted"`

## Geaenderte Dateien

| Datei | Aenderung |
|-------|----------|
| `packages/core/src/core/agent.ts` | maxIterations 10->100, Last-Turn-Warning, Error-Handler inject statt throw, Crash-Catch, RunResult-Typ, main_loop label |
| `packages/agent/src/daemon/runtime.ts` | WhatsApp "Aborted"-Text entschaerft (2 Stellen) |
| `packages/core/src/browser/runner.ts` | maxTurns-Check aktualisiert |
| `packages/core/tests/agent.test.ts` | 2 bestehende Tests auf neues Verhalten aktualisiert |
| `packages/core/tests/core/retryIntegration.test.ts` | 2 bestehende Tests auf neues Verhalten aktualisiert |
| `packages/core/tests/agentResilience.test.ts` | **Neu**: 6 Resilience-Tests |

## Testergebnisse

- `pnpm typecheck`: **clean** (core + agent)
- `pnpm build`: **clean** (core)
- **6 neue Resilience-Tests**: alle gruen
  - exec non-zero exit -> Turn laeuft weiter
  - API 429 Rate-Limit -> retried, Turn laeuft weiter
  - Code-Exception in tool.execute -> isError, Turn laeuft weiter
  - maxIterations exhausted -> aborted:false, Turn-Limit-Message
  - Last-Turn-Warning injiziert
  - User-Abort bleibt backward-compatible
- **4 aktualisierte Tests**: alle gruen
- **Alle anderen existierenden Tests**: gruen (bis auf pre-existing `sudo`-Test)

## Nicht gemacht
- Kein Push, kein Restart, kein Deploy
- Keine Aenderung am WhatsApp abort-and-restart Mechanismus (unveraendert)
- Keine Aenderung an maxTurns im Browser-Config (bleibt 100)
