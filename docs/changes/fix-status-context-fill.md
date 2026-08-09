# fix: /status um Context Fill und Session-Tokens ergänzen

## Problem

Der `/status`-Befehl zeigte nur `Tokens today: 5.5M in / 42.8k out` — Tagessummen,
die nichts über die zentrale Frage aussagen: **Wie voll ist der Kontext der
aktuellen Session, und wann droht Kompaktierung?**

## Befund

- `statusSummary.ts` hatte `sessionUsage` bereits als Fallback für die
  Tages-Zeile, aber es gab keine Session-spezifische Zeile und keine
  Context-Fill-Anzeige.
- Das Context-Limit steht als `contextWindow` auf dem pi-ai `Model` (Pflichtfeld)
  und wird in `resolveModel.ts`/`buildCustomModel` aus der Model-Config befüllt
  (z. B. DeepSeek Flash: 131072, Kimi K2.7: 262144). Es wurde nur im StatusBar
  der TUI verwendet, nicht in `/status`.
- Der Daemon hält `entry.session.tokenTotals` (Session-Token-Summen) und
  `entry.messages` (live Kontext) bereits vor; die TUI hält `sessionUsage` aus
  den `turn-complete`-Responses.

## Was geändert wurde

**`packages/agent/src/core/statusSummary.ts`**

- `StatusContext` um `contextWindow` (Modell-Context-Limit) und `contextTokens`
  (Live-Schätzung des Kontexts) erweitert.
- `StatusSummary` um `sessionTokensIn`, `sessionTokensOut` und `contextFill`
  erweitert.
- `buildStatusSummary` berechnet:
  - `Session: <in> in / <out> out` aus `sessionUsage` (input + cacheRead +
    cacheWrite als "in", output als "out") — diese Session, nicht heute.
  - `Context fill: X%` = `contextTokens / contextWindow`, gekappt bei 100 %.
    Ohne `contextTokens` fällt es auf die Session-Input-Summe zurück.
- `Tokens today` bleibt als eigene Zeile erhalten.
- `formatStatusSummary` um die zwei neuen Zeilen erweitert.

**`packages/agent/src/daemon/runtime.ts`**

- `/status`-Handler löst jetzt das Session-Modell auf (`resolveModelRef` mit
  Profile-Fallback) und übergibt `contextWindow` an `buildStatusSummary`.
- `contextTokens` wird live geschätzt: `estimateTokens(entry.messages)` +
  `estimateContextOverhead(prompt, tools)` — dieselbe Heuristik wie der
  Kompaktierungs-Trigger (`shouldCompact`), damit die Prozentzahl direkt die
  Frage "wann kompaktieren?" beantwortet (Trigger bei 80 %).
- `sessionUsage` wird aus `entry.session.tokenTotals` übergeben.

**`packages/agent/src/cli/App.tsx`**

- `/status`-Aufruf übergibt `contextWindow: activeModel.contextWindow`
  (kommt aus der Model-Config) und das bereits vorhandene `sessionUsage`.

## Tests

- `tests/core/statusSummary.test.ts`: neue Cases für Context Fill (Berechnung,
  100 %-Cap, Fallback auf Session-Input, `n/a` ohne `contextWindow`/Session)
  und Session-Tokens (in/out getrennt von heute, n/a ohne Session, Formatierung).
- `tests/core/tokenFlow.test.ts`: Stage-4-Assertions um `sessionTokensIn`/
  `sessionTokensOut` ergänzt.
- `tests/daemon/modelRef.test.ts`: läuft unverändert grün.
- `pnpm build` + `pnpm typecheck` grün; alle Agent-Tests grün (481/481).
  Einzige Core-Rot: `exec.test.ts > elevated > id -u` — Umgebungsabhängig
  (kein passwordless sudo), schlägt auch auf unverändertem `main` fehl.

## Dateien

- `packages/agent/src/core/statusSummary.ts`
- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/src/cli/App.tsx`
- `packages/agent/tests/core/statusSummary.test.ts`
- `packages/agent/tests/core/tokenFlow.test.ts`
- `docs/changes/fix-status-context-fill.md`
