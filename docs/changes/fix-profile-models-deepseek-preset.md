# Agent-Profile auf OpenRouter-Preset @preset/deepseek-flash umgestellt

## Problem/Symptom

Die Pipeline-Profile (Session-End, Distillation, Curator) referenzierten Modelle,
die zur Laufzeit nicht auflösbar waren:

- `minimax/MiniMax-M2.7` — Provider in pi-ai vorhanden, aber kein `MINIMAX_API_KEY`
  in `~/harness/.env` konfiguriert.
- `deepseek/v4-flash` — keine gültige Modell-ID: pi-ai kennt den Provider `deepseek`
  nur mit den Modellen `deepseek-v4-flash` / `deepseek-v4-pro` (Bindestrich, nicht Slash).

Damit war kein einziges Pipeline-Profil tatsächlich ausführbar.

## Befund

Die Modell-Auswahl für den normalen Betrieb nutzt OpenRouter-Presets aus
`~/harness/config.json` (`openrouter` / `@preset/deepseek-flash`, Alias "DeepSeek
Flash"). Dieses Preset ist als Default-Modell aktiv und per API-Key
(`OPENROUTER_API_KEY`) versorgt. Die Profile zeigten aber auf die nicht
verfügbaren Modelle oben.

## Was geändert wurde

Nur das `model:`-Feld im Frontmatter der 5 Pipeline-Profile — auf das bestehende
OpenRouter-Preset `@preset/deepseek-flash`:

| Profil | vorher | nachher |
|--------|--------|---------|
| `session-end` | `minimax/MiniMax-M2.7` | `@preset/deepseek-flash` |
| `distillation-daily` | `minimax/MiniMax-M2.7` | `@preset/deepseek-flash` |
| `distillation-wiki` | `minimax/MiniMax-M2.7` | `@preset/deepseek-flash` |
| `curator-stage1` | `deepseek/v4-flash` | `@preset/deepseek-flash` |
| `curator-stage2` | `deepseek/v4-flash` | `@preset/deepseek-flash` |

Keine weiteren Änderungen — kein Code, keine Parser-/Resolution-Anpassung.

## Welche Dateien

- `packages/agent/agents/session-end/agent.md`
- `packages/agent/agents/distillation-daily/agent.md`
- `packages/agent/agents/distillation-wiki/agent.md`
- `packages/agent/agents/curator-stage1/agent.md`
- `packages/agent/agents/curator-stage2/agent.md`

## Tests

- `pnpm build` grün, `pnpm typecheck` grün
- `packages/core` Profil-Parser-Tests (`tests/profiles/profiles.test.ts`,
  inkl. "loads all shipped built-in profiles without errors"): 22/22 grün
- Agent-Suite (`packages/agent`): 46 Files, 472 Tests grün
- Bekannt: `packages/core/tests/tools/exec.test.ts` schlägt fehl (Root-Privilegien-
  Test, `id -u` erwartet `0`) — pre-existing, reproduzierbar auf unverändertem
  `f6f9dc4`, unabhängig von diesem Change.
