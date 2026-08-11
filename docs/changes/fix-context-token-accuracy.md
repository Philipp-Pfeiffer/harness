# fix: Context-Fill-Anzeige und Token-Statistiken aus echter Provider-Usage

## Problem

Der `/status`-Output des Harness zeigte `Context fill: 25% (32.5k / 128.0k)` — gerechnet aus einer **lokalen Char-Schätzung** statt aus den gemessenen Token-Werten des Providers. Dadurch wich die Anzeige von den OpenRouter-Logs ab. Token-Statistiken (today/session) und Cache Hit basierten zwar bereits auf echten `response.usage`-Werten, aber der Context-Fill war die Lücke.

## Befund

### Lernassistent (Referenz)

Der Lernassistent (`~/dev/lernomat`) hat **keine eigene Token-Schätzung** — er importiert `AgentEvent`/`RunResult`/`TokenUsage` aus dem vendorierten `@harness/core` (`vendor/harness/harness-core-0.0.1.tgz`) und zeigt die **echten Provider-Usage-Werte**:

- **Sammlung:** `src/turn.ts:108-117` — ein `TurnCollector` übernimmt `usage`-Events: „Die usage-Felder sind kumulativ für den Lauf; der letzte Stand gilt." (input/output/totalTokens/cacheRead/cacheWrite)
- **Anzeige:** `web/app.js:534` — `t.tokens.total` → „12.345 Tokens" unter der Nachricht.
- **Quelle der Werte:** im vendierten Core `node_modules/@harness/core/src/core/agent.ts:557-561` — `response.usage.input/output/totalTokens/cacheRead/cacheWrite` direkt aus der pi-ai-Assistant-Response. pi-ai mappt für OpenAI-kompatible Provider (`providers/openai-completions.js:763-786`) `prompt_tokens`/`completion_tokens`/`prompt_tokens_details.cached_tokens`/`cache_write_tokens` 1:1 aus der API-Response — inkl. Korrektur, dass OpenRouter `cached_tokens` als (previous hits + current writes) meldet.
- **Fallback:** `src/turn.ts:171-177` `pickTokens()`: `RunResult.usage` ist Hauptquelle, beobachteter `usage`-Stand als Rückfall bei Abbruch. Guard: nur nutzen, wenn `total > 0 || input > 0 || output > 0`.

### Harness heute

Der Agent-Loop (`packages/core/src/core/agent.ts`) emittiert **bereits echtes Provider-Usage**: `response.usage` (pi-ai) wird pro Iteration akkumuliert (Zeilen 729-733) und als `RunResult.usage` + `usage`-Event (Zeile 742) ausgegeben. Auch `turn.tokens` (runtime.ts:1317-1323) und die JSONL-Turn-Metriken (`metrics.ts` recordTurn) enthalten echte Werte. **Die Ungenauigkeit steckte ausschließlich in der Context-Fill-Berechnung des `/status`:**

1. **`packages/agent/src/daemon/runtime.ts:2641-2658`** (alt): `contextTokens = estimateTokens(entry.messages) + estimateContextOverhead(promptText, toolSet)` — Char-Schätzung (`Math.ceil(chars/4)` + 3/message, `compaction.ts:59-91`), kein Bezug zur echten Kontextgröße des Providers.
2. **`packages/agent/src/core/statusSummary.ts:255-261`** (alt): Fallback `sessionUsage.inputTokens + cacheRead + cacheWrite` — die **kumulierte Input-Spend aller Turns** (Session-Summe), nicht der aktuelle Context-Inhalt (kompaktierte History nicht reflektiert).
3. `tokens today`/`session` und Cache Hit kamen bereits aus echten Werten (bestätigt via `tokenFlow.test.ts`).

### Abgleich — was sich ändern musste

| Anzeige | vorher | nachher |
|---|---|---|
| Context fill | `estimateTokens()` (Schätzung) | echte Usage des letzten Turns (`result.usage.inputTokens + cacheRead + cacheWrite`) |
| Fallback 1 | — | lokale Schätzung (nur wenn kein Turn Usage gemessen hat) |
| Fallback 2 | Session-Input-Spend | Session-Input-Spend (unverändert) |
| Provider ohne usage | 0-Werte drückten Fill auf 0% | Guard: all-zero = keine Messung → Schätzung |
| tokens today/session | echte Werte (bestätigt) | unverändert |
| cache hit | echte cached-token-Felder (bestätigt) | unverändert |

## Was geändert wurde

- **`packages/agent/src/daemon/runtime.ts`**
  - `SessionEntry` um `lastUsage` erweitert (echte Usage des zuletzt abgeschlossenen Turns).
  - In beiden Turn-Pfaden (IPC `submit-turn` + WhatsApp) wird `entry.lastUsage` nach `recordTurn` aus `result.usage` gesetzt.
  - Beim Resume (`loadSession`) wird `entry.lastUsage` aus dem Transcript rekonstruiert — nach Daemon-Neustart zeigt `/status` weiterhin echte Werte.
  - `/status`-Handler: berechnet weiterhin die Schätzung als Fallback, übergibt aber `lastUsage` als bevorzugte Quelle.

- **`packages/agent/src/core/statusSummary.ts`**
  - `StatusContext` um `lastTurnUsage` erweitert.
  - Context-Fill-Priorität: `lastTurnUsage` (echt, gemessen) → `contextTokens` (Schätzung) → `sessionUsage` (Session-Spend).
  - **Guard für Provider ohne Usage:** `hasMeasuredLastTurn` prüft `totalTokens > 0 || inputTokens > 0 || outputTokens > 0` (identisch zur Lernassistent-Prüfung in `pickTokens`) — all-zero-Werte zählen als „keine Messung", sodass der Fallback greift.

- **`packages/agent/src/core/session.ts`**
  - `loadSession()` liefert zusätzlich `lastTurnUsage`: Scan des Transcripts vom Ende, der letzte Turn mit gemessenen Tokens gewinnt; all-zero-Turns werden übersprungen.

## Welche Tests

- `packages/agent/tests/core/statusSummary.test.ts` (42 Tests):
  - Fixture: `lastTurnUsage` mit bekannten Werten (input=32500, cacheRead=8000, cacheWrite=2000) → Fill exakt `33%`, `contextTokens = 42.5k`.
  - `lastTurnUsage` gewinnt gegen eine falsche Schätzung (`contextTokens`).
  - Fallback: all-zero `lastTurnUsage` → Schätzung (Provider ohne Usage) bzw. Session-Spend.
  - Bestehende Fill/Format-Tests unverändert grün.
- `packages/agent/tests/core/session-resume.test.ts` (13 Tests):
  - `loadSession` liefert die letzte gemessene Turn-Usage; überspringt trailing all-zero-Turns; `undefined` wenn nie gemessen.
- `packages/agent/tests/core/tokenFlow.test.ts` (2 Tests):
  - End-to-End mit Mock-Provider: `lastTurnUsage` aus `result.usage` → Fill exakt aus echten Werten, Schätzung (99_999) gewinnt nicht.

## Validierung

- `pnpm build` ✅
- `pnpm typecheck` ✅
- `pnpm -r test`: alle Tests grün bis auf die bekannten Flakes `exec.test.ts` (sudo ohne Passwort) — wie freigegeben.
- Kein Push, kein Restart, kein Deploy.
