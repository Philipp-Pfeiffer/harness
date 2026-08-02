# feat: Distillation- und Curator-Agent-Profile

## Problem
Distillation-, Session-End- und Curator-Prompts existierten nur im Harness-Tracker (Notion). Im Repo lag nur ein `distillation`-Stub ohne echten Persona-Body.

## Befund (Verifikation)
- **Profil-Pfade:** Built-in unter `packages/agent/agents/<name>/agent.md`; User-Override in `$HARNESS_HOME/agents/<name>/agent.md` (Loader: `packages/core/src/profiles/loader.ts`).
- **Frontmatter-Keys:** `name`, `model`, `thinking`, `tools`, `memory`, `skills`, `temperature`, `maxTokens` — unbekannte Keys werfen `AgentProfileFrontmatterError`.
- **Memory-Zonen:** `core` | `notes` (kein `vault`).
- **Runtime-Tool-Namen:** `readFile`, `write`, `edit`, `exec`, `process`, `search_memory`, `web_search`, `web_fetch`, `send_file`, `load_skill`, `find_skill`, `browser`, `image`.
- **Platzhalter:** `{NAME}`, `{datum}`, `{letzter_pass}` bleiben im Body — Loader substituiert nur `{{var}}`; einfache Klammern werden nicht validiert.
- **Modelle:** `deepseek/v4-flash` wird beim Parsen nicht eager validiert; Runtime-Fehler erst bei Session-Start über `resolveModel`.

## Änderungen
| Datei | Was |
|---|---|
| `packages/agent/agents/distillation-daily/agent.md` | Neu — Pass 1 Daily Note |
| `packages/agent/agents/distillation-wiki/agent.md` | Neu — Pass 2 Wiki-Extraction |
| `packages/agent/agents/session-end/agent.md` | Neu — Session-End-Protokollant |
| `packages/agent/agents/curator-stage1/agent.md` | Neu — Curator Aggregator |
| `packages/agent/agents/curator-stage2/agent.md` | Neu — Curator Reviewer |
| `packages/agent/agents/distillation/agent.md` | Entfernt (Stub) |
| `packages/agent/tests/daemon/cronJobs.test.ts` | Beispiel-Profil `distillation-daily` |
| `packages/agent/skills/manage-cron-jobs/skill.md` | Cron-Beispiel aktualisiert |
| `docs/architecture/daemon.md` | Built-in-Profil-Liste aktualisiert |

**Frontmatter-Anpassungen** (Bodies unverändert):
- `tools: [read, write]` → `tools: readFile, write` (YAML-Array-Syntax nicht unterstützt; `read` → `readFile`)
- Inline-Kommentare in Frontmatter entfernt (würden Model-ID verunreinigen)

**`core.md`:** Persönliche Main-Persona nach `$HARNESS_HOME/core.md` abgelegt (lokaler State, nicht committed). Kein `core.md.example` — Repo nutzt nur `.env.example` / `harness.config.example.json`.

## Tests
- `packages/core/tests/profiles/profiles.test.ts` — Parse-Test für alle Built-in-Profile
- `tsc --noEmit` + bestehende Profile-/Daemon-Tests

## Nicht Teil dieses Changesets
Trigger, Cron-Jobs, Session-Close-Hooks, Runner-Verkettung (Task „Distillation-Orchestrierung").
