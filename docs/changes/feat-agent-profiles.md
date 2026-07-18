# feat: Agent-Profile

## Problem/Symptom

Der Daemon kannte genau einen Agenten: ein System-Prompt, ein Modell, ein Tool-Set für alle Sessions. Es gab keine Möglichkeit, Sessions mit unterschiedlichen Personas, Modellen oder eingeschränkten Tool-Sets zu starten — weder per IPC noch für Cron-Jobs.

## Befund

Sessions brauchen ein deklaratives Profil: Persona-Prompt plus Laufzeit-Parameter (Modell, Thinking, Tool-Allowlist, Memory-Zonen, Skill-Hot-Set, Sampling). Anforderungen:

1. Bare-Agent: Basis-System-Prompt auf Minimum (Tools, Umgebung, Runtime-Konventionen) — alles Persona-/Aufgabenspezifische kommt aus dem Profil.
2. Profil-Files `agents/<name>/agent.md`: Built-in im Repo + User-Profile in `$HARNESS_HOME/agents/` (User überschreibt Built-in bei Namensgleichheit, wie bei Skills).
3. Loader analog Skill-Loader: validieren, Fehler sammeln, nie werfen.
4. Profil `default` = bisheriger Main-Agent-Prompt — Verhalten ohne Profilangabe bleibt gleich.
5. `create-session` (IPC) + Cron-Job-Frontmatter (`agent:`) wählen das Profil.

## Was geändert wurde

### Neue Dateien

| Datei | Beschreibung |
|-------|-------------|
| `packages/core/src/profiles/types.ts` | Profil-Typen: `AgentProfile`, `AgentProfileFrontmatter`, `MemoryZone` (`core`\|`notes`), `ALL_MEMORY_ZONES` |
| `packages/core/src/profiles/frontmatter.ts` | Frontmatter-Parser für agent.md: validiert name (Ordner-Match), model (`provider/model-id`), thinking, tools, memory, skills, temperature, maxTokens; unbekannte Keys → Fehler; `{{var}}`-Substitution im Body |
| `packages/core/src/profiles/loader.ts` | `loadAgentProfiles()`: scannt Built-in- + User-Verzeichnis, User überschreibt Built-in bei Namensgleichheit, sammelt Fehler ohne zu werfen |
| `packages/core/src/profiles/index.ts` | Public exports |
| `packages/core/prompts/base-prompt.md` | Bare-Base-Prompt: minimale Runtime-Konventionen (Tools, Umgebung), kein Persona-Inhalt |
| `packages/agent/agents/default/agent.md` | Built-in Default-Profil — Body = bisheriger `system-prompt.md`-Persona-Inhalt |
| `packages/agent/agents/distillation/agent.md` | Distillation-Profil (Stub mit Platzhalter-Persona, wird später gefüllt) |
| `packages/agent/src/core/profilePrompt.ts` | `composeProfilePrompt()`: base + persona + `<core_memory>` (Zone `core`) + Hot-Set (`skills: true`) |
| `packages/core/tests/profiles/profiles.test.ts` | 21 Tests: Frontmatter-Parsing, Defaults, Validierungsfehler, Var-Substitution, Loader (Override, Fehler-Sammlung, fehlende Dirs) |
| `packages/agent/tests/core/profilePrompt.test.ts` | 6 Tests: Prompt-Komposition inkl. Default-Äquivalenz zur bisherigen Komposition |
| `packages/agent/tests/daemon/agentProfiles.test.ts` | 10 Tests: unbekanntes Profil → sauberer Fehler, Profil-Session (Prompt + Tool-Subset), Zonen-Gating von `search_memory`, Modell-Override + ungültiges Modell, Turn läuft auf Profil-Agent, Default-Verhalten, Profil-Persistenz, Cron mit `agent:` |

### Geänderte Dateien

| Datei | Änderung |
|-------|---------|
| `packages/core/src/config/paths.ts` | `HarnessPaths.agentProfiles` → `$HARNESS_HOME/agents/`, in `ensureDirs()` aufgenommen |
| `packages/core/src/core/agent.ts` | `AgentConfig` + `createAgent()` akzeptieren optionale `temperature`/`maxTokens` (Sampling-Parameter, an `stream()` durchgereicht) |
| `packages/core/src/lib.ts` | Exportiert das Profil-Modul |
| `packages/core/prompts/README.md` | `base-prompt.md` im Injection-Register |
| `packages/agent/src/core/session.ts` | `Session`/`SessionIndexEntry`/`CreateSessionOptions` mit optionalem `profile` — persistiert im Session-Index, beim Resume wiederhergestellt (absent bei Alt-Sessions = `default`) |
| `packages/agent/src/daemon/types.ts` | IPC `create-session` mit optionalem `profile`; `session-created` meldet das Profil zurück (optional, abwärtskompatibel) |
| `packages/agent/src/daemon/jobs.ts` | Cron-Job-Frontmatter mit optionalem `agent`-Feld (Profilname, validiert gegen lowercase-hyphenated) |
| `packages/agent/src/daemon/runtime.ts` | `initAgent()` lädt Profile und baut den Default-Agent aus dem `default`-Profil (Prompt: base + persona + core + hot-set); `create-session` löst Profile auf (unbekannt → sauberer Fehler); pro Profil lazily gecachter Agent mit eigenem Prompt/Modell/Tool-Subset; `submit-turn` nutzt den Profil-Agent der Session; Ambient Hints nur bei `notes`-Zone; `runCronAgentJob()` reicht `job.agent` durch |
| `packages/agent/skills/manage-cron-jobs/skill.md` | `agent`-Feld dokumentiert + Beispiel-Job mit Profil |
| `AGENTS.md` | Topology-Tabelle (`agents/`), Cron-Sektion (`agent`-Feld), neuer Abschnitt "Agent-Profile" |

## Feature-Details

### Profil-Format

```
$HARNESS_HOME/agents/<name>/agent.md   (User, höhere Priorität)
packages/agent/agents/<name>/agent.md  (Built-in)
```

Frontmatter (alle außer `name` optional):
- `name` (required, muss Ordnername matchen, lowercase-hyphenated)
- `model` (`provider/model-id` — überschreibt das Daemon-Default-Modell der Session)
- `thinking: true|false` (überschreibt `inlineThinking` der Modell-Config)
- `tools: readFile, exec, ...` (Allowlist; absent = volles Tool-Set; leer = keine Tools; `search_memory` erfordert zusätzlich die `notes`-Zone)
- `memory: core, notes` (Zonen; absent = alle; `core` = core.md-Block im Prompt, `notes` = `search_memory` + Ambient Hints)
- `skills: true|false` (Skill-Hot-Set im Prompt, Default true)
- `temperature`, `maxTokens` (Sampling-Parameter)

Body = Persona-Prompt, `{{inboxPath}}` wird ersetzt. Finaler System-Prompt:
`base-prompt.md` + Persona + `<core_memory>` (bei Zone `core`) + Hot-Set (bei `skills: true`).

### Default-Verhalten

Sessions ohne Profilangabe laufen unter `default`. Der Built-in-Default-Body ist der bisherige `system-prompt.md`-Inhalt; Komposition, Modell, Tool-Set und Hot-Set bleiben gleich — einzig der bare Base-Prompt ist als neuer Block vorangestellt. Die TUI (In-Process-Mode) ist unverändert und nutzt weiterhin `system-prompt.md` direkt; die Persona existiert daher aktuell zweimal (TUI-Prompt + Default-Profil) — bewusste Duplikation, bis die TUI auf Profile umgestellt wird.

### Fehlerpfade

- Unbekanntes Profil bei `create-session` → `{type:"error"}` mit Liste verfügbarer Profile (kein Throw).
- Nicht auflösbares Profil-Modell → sauberer Fehler bei `create-session`.
- Cron-Job mit unbekanntem `agent:`-Profil → Run schlägt fehl, wird vom Scheduler geloggt (Daemon läuft weiter).
- Kaputte Profil-Dateien landen in `errors[]` des Loaders, der Daemon startet trotzdem; fehlt das `default`-Profil, fällt der Daemon auf die `system-prompt.md`-Persona zurück.

## Tests

- `packages/core/tests/profiles/profiles.test.ts` (21)
- `packages/agent/tests/core/profilePrompt.test.ts` (6)
- `packages/agent/tests/daemon/agentProfiles.test.ts` (10)
- `packages/agent/tests/daemon/cronJobs.test.ts` (+3 für das `agent`-Feld)

Validierung: `tsc --noEmit` clean in beiden Packages, komplette vitest-Suites grün (core 392, agent 274).
