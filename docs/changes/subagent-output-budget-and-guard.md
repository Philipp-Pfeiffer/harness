# feat: Subagent — Modell-Limit, Guard gegen ungeparste Tool-Calls, verwaiste Tool-Referenz

## Problem

Der `coder`-Subagent brach nach ~2 s mit `status: done` und zero Code-Änderungen
ab. Die `result.json`-Summary enthielt statt eines Reports den rohen Text eines
**ungeparsten Tool-Calls** (z. B. `<tool_call><invoke name="exec">…`), den das
Modell als Prosa emittiert hatte statt als strukturierten Tool-Call.

Drei Ursachen (die dritte ist der eigentliche Hauptbug):

1. **Verwaiste Tool-Referenz (Hauptbug).** `createAsyncAgentRunner` erhielt
   `loadedTools: this.allTools`, während `this.allTools` noch das Feld-Initial
   `[]` war (Deklaration `private allTools: Tool[] = []`). Die echten Tools
   werden erst ZEILEN SPÄTER via `this.allTools = loadTools(...)` neu zugewiesen
   — der Runner hielt aber dauerhaft die Referenz auf das leere `[]`.
   `resolveRoleTools` filterte also aus einem leeren Array → **keine Tools im
   API-Call** → das Modell konnte keinen strukturierten Tool-Call machen und
   emittierte ihn als reinen Text. Deshalb `toolCallCount: 0` und nur ~2 s
   Laufzeit (ein schneller LLM-Call ohne Tool-Roundtrip).

2. **Hartes Output-Budget.** Der Runner setzte `maxTokens: 4096` fest und
   halbierte damit das Modell-Limit (DeepSeek-Presets: 8192).

3. **Stille Fehlklassifikation.** Ein Run mit `toolCallCount: 0` und
   Tool-Call-Markup im finalen Text wurde als `done` statt als `error`
   markiert — der Fehler blieb unsichtbar.

## Änderungen

`packages/core/src/agent/asyncAgentRunner.ts`:

- `AsyncAgentOptions.loadedTools` akzeptiert jetzt zusätzlich einen Provider
  `(() => Tool[])`. Im `start()`-Pfad wird der Provider **lazy** ausgewertet
  (`typeof opts.loadedTools === "function" ? opts.loadedTools() : opts.loadedTools`),
  sodass spät befüllte Tool-Arrays korrekt ankommen.

- `maxTokens: 4096` → `maxTokens: model.maxTokens` (am aufgelösten Modell ausgerichtet).

- Neuer Guard nach `agent.run`: Endet ein Run mit `toolCallCount === 0` **und**
  enthält `finalMessage` Markup eines ungeparsten Tool-Calls
  (`<tool_call`/`<invoke`/`<function_call`), wird der Task als `error` finalisiert
  (`Lauf endete mit ungeparstem Tool-Call statt strukturiertem Aufruf …`) statt
  still als `done`.

`packages/agent/src/daemon/runtime.ts`:

- `createAsyncAgentRunner({ loadedTools: this.allTools })` → `loadedTools: () => this.allTools`.
  Der Daemon reicht jetzt einen Provider statt der (zu diesem Zeitpunkt noch
  leeren) Array-Snapshot — die zirkuläre Abhängigkeit (`loadTools` braucht den
  Runner via `subagent.runner`, der Runner braucht die Tools) wird dadurch sauber
  aufgelöst.

`packages/core/tests/subagent/asyncAgentRunner.test.ts`:

- Neuer Test: Provider wird lazy ausgewertet (Tools werden erst NACH
  Runner-Konstruktion gesetzt und sind trotzdem sichtbar).

## Verifikation

- `pnpm build && pnpm typecheck` grün (core + agent).
- `pnpm -C packages/core test run tests/subagent/asyncAgentRunner.test.ts tests/subagent/subagentTool.test.ts`:
  37/37 grün (+1 neuer Test → 38/38 in der Einzeldatei).
- Isolierter E2E-Repro (`/tmp/diag9.mjs`) mit echten Tools/Prompt/Modell/Key:
  3 Tool-Calls, 4 Turns, korrekter Report — beweist, dass der Runner-Pfad
  ansonsten intakt ist und der Fehler ausschließlich an der leeren Tool-Referenz lag.

## Hinweis

Kein `/deploy` durch den Agent. Deploy nur nach Philipps Bestätigung.
