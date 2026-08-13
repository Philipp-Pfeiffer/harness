# Fix: DeepSeek-Pro-Thinking-Leak — `reasoningEffort` durchreichen

## Problem/Symptom

Bei DeepSeek-Pro-Modellen (OpenRouter) leakt das Denken als sichtbarer Content-Text
in die Assistant-Antwort, statt im `reasoning`-Feld der API zu landen.

## Befund

pi-ai (`@mariozechner/pi-ai` 0.70.6, `dist/providers/openai-completions.js`,
`buildParams`): bei `compat.thinkingFormat === "openrouter" && model.reasoning`
sendet pi-ai IMMER `reasoning: { effort: "none" }`, wenn keine explizite
`options.reasoningEffort` gesetzt ist. `effort: "none"` bringt DeepSeek (OpenRouter)
dazu, sein Denken als UNGETAGGTEN Content-Text zu streamen statt ins
`reasoning`-Feld — das Denken leakt als Text in den Output.

## Was geändert wurde

Fix-Richtung: Dem Modell `reasoning: true` UND einen expliziten `reasoningEffort`
(z. B. `"high"`) geben. Dann sendet pi-ai `reasoning: { effort: "high" }` → Denken
landet im `reasoning`-Feld → pi-ai emittiert `thinking_delta` → Harness filtert es.

**`packages/core/src/config.ts`**:
- `ConfigModel` um `reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"`
  erweitert.

**`packages/core/src/core/resolveModel.ts`**:
- `ResolvedModel` um `reasoningEffort?: string` erweitert.
- `buildCustomModel()` reicht `config.reasoningEffort` ins Return-Objekt durch.

**`packages/core/src/core/agent.ts`**:
- `streamOptions` um `reasoningEffort?: string` erweitert.
- Im Run-Loop wird `resolvedModel.reasoningEffort` (falls gesetzt) in
  `streamOptions` übernommen → fließt via `stream()` an pi-ai durch.

## Welche Dateien

- `packages/core/src/config.ts`
- `packages/core/src/core/resolveModel.ts`
- `packages/core/src/core/agent.ts`
- `packages/core/tests/core/resolveModel.test.ts` (Test: Pass-Through + `undefined`)
- `packages/core/tests/core/retryIntegration.test.ts` (Test: `reasoningEffort` im stream-Options)

## Tests

- `pnpm typecheck` grün (core + agent)
- `pnpm -C packages/core test`: 556 Tests grün (nur `tests/tools/exec.test.ts`
  schlägt fehl — benötigt passwordless sudo, ist auch auf Baseline rot)
- `pnpm -C packages/agent test`: 688 Tests grün (nur `tests/cli/non-tty.test.ts`
  schlägt fehl — TTY-Umgebung, auch auf Baseline rot)
