# feat: Subagent — Modell-Limit statt hartes 4096-Cap + Guard gegen ungeparste Tool-Calls

## Problem

Der `coder`-Subagent brach nach ~2–3 s mit `status: done` und zero Code-Änderungen
ab. Die `result.json`-Summary enthielt statt eines Reports den rohen Text eines
**ungeparsten Tool-Calls** (z. B. `<tool_call><invoke name="exec">…`), den das
Modell als Prosa emittiert hatte statt als strukturierten Tool-Call.

Zwei Ursachen:

1. **Hartes Output-Budget.** Der Runner setzte `maxTokens: 4096` fest. Das
   halbierte das Modell-Limit (die DeepSeek-Presets haben `maxTokens: 8192`) und
   ließ bei langer Briefing + Reasoning-Modellen (`@preset/deepseek-pro`,
   `reasoning: true`) keinen Platz mehr für einen sauberen strukturierten
   Tool-Call — das Modell "verfiel" in Prosa.

2. **Stille Fehlklassifikation.** Ein Run, der mit `stopReason: "stop"` und
   `toolCallCount: 0` endete (nur Text, kein Tool-Call), wurde als `done`
   markiert. Der eigentliche Fehler blieb damit unsichtbar.

## Änderungen

`packages/core/src/agent/asyncAgentRunner.ts`:

- `maxTokens: 4096` → `maxTokens: model.maxTokens`. Der Subagent richtet sein
  Output-Budget jetzt am aufgelösten Modell aus (default 8192 bei den DeepSeek-
  Presets) statt es hart zu halbieren. Gleiches Muster wie der Haupt-Agent, der
  `maxTokens` ebenfalls aus der Modell-/Profil-Konfiguration bezieht.

- Neuer Guard nach `agent.run`: Endet ein Run mit `toolCallCount === 0` **und**
  enthält sein `finalMessage` Markup eines ungeparsten Tool-Calls
  (`<tool_call`/`<invoke`/`<function_call`), wird der Task als `error`
  finalisiert (`Lauf endete mit ungeparstem Tool-Call statt strukturiertem
  Aufruf …`) statt still als `done`. Ein legitimer "Textantwort ohne Tools"
  (z. B. reine Fragebeantwortung) bleibt unberührt — der Guard matcht nur das
  konkrete Fehlersymptom.

## Verifikation

- `pnpm build && pnpm typecheck` grün (core + agent).
- `pnpm -C packages/core test run tests/subagent/*.test.ts`: 37/37 grün.
- Die 3 vorhandenen `exec.test.ts`-Failures (Sudo ohne Passwort im
  Test-Worktree) bestehen bereits auf `main` — unabhängig von dieser Änderung.

## Hinweis

Kein `/deploy` durch den Agent. Deploy nur nach Philipps Bestätigung.
