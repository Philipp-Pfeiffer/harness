# feat: Skill-System MVP

## Problem/Symptom

Harness hatte kein Skill-System: Es gab keine strukturierte Möglichkeit, wiederverwendbares Agenten-Wissen (Vorgehensweisen, Referenzen, Skripte) zu definieren, zu laden oder dem Agenten zur Verfügung zu stellen. Wissen war verstreut in `core.md` und `AGENTS.md`, ohne Discoverability oder Lebenszyklus-Management.

## Befund

Der Agent benötigt:
1. Ein Format für Skills (agentskills.io-kompatibel)
2. Einen Loader, der Skills scannt und validiert
3. Tier-0-Hot-Set für pinned + häufig genutzte Skills im System-Prompt
4. Tools zum Laden und Discoverieren von Skills
5. Telemetry für Nutzungsmetriken
6. `harness doctor` für Validierung
7. Echten ersten Skill (`manage-cron-jobs`)

## Was geändert wurde

### Neue Dateien

| Datei | Beschreibung |
|-------|-------------|
| `packages/core/src/skills/types.ts` | Skill-Typen: `SkillRecord`, `SkillFrontmatter`, `SkillTelemetry`, etc. |
| `packages/core/src/skills/frontmatter.ts` | Frontmatter-Parser für skill.md (validiert name, description, level, requires, status, pinned, routable) |
| `packages/core/src/skills/loader.ts` | Skill-Loader: scannt Verzeichnisse, validiert, sammelt Errors ohne zu werfen; `validateRequires()`, `computeRoutableSkills()` |
| `packages/core/src/skills/telemetry.ts` | Telemetry-Sidecar: `_telemetry.json` lesen/schreiben, `recordSkillUse()` |
| `packages/core/src/skills/hotSet.ts` | Tier-0-Hot-Set-Builder: pinned + Top-N nach uses, Token-Budget ~2k, excludes draft/stale/archive |
| `packages/core/src/skills/index.ts` | Public exports für Skill-System |
| `packages/core/src/tools/loadSkill.ts` | `load_skill(name)` Tool — lädt volle skill.md, aktualisiert Telemetry |
| `packages/core/src/tools/findSkill.ts` | `find_skill(query)` Tool — QMD searchLex+searchVector+RRF, fallback keyword search; routability filtering |
| `packages/agent/src/cli/doctor.ts` | `harness doctor` — Frontmatter-Validierung, requires-Check, Token-Warnung, dark skills |
| `packages/agent/skills/manage-cron-jobs/skill.md` | Erster echter Skill: Job-File-Spec, Beispiele, Job-Storm-Warnung |
| `packages/core/tests/skills/skills.test.ts` | 40 Tests: Frontmatter-Parsing, Loader, requires-Validation, Routability, Hot-Set, Telemetry, load_skill, find_skill |

### Geänderte Dateien

| Datei | Änderung |
|-------|---------|
| `packages/core/src/tools/registry.ts` | `loadTools()` akzeptiert jetzt `LoadToolsOptions`-Objekt mit `skills`, `skillsDir`, `findSkillStore`; Rückwärts-kompatibel mit alter 2-Arg-Signatur |
| `packages/core/src/lib.ts` | Exportiert alle Skill-Typen und -Funktionen sowie `createLoadSkillTool`, `createFindSkillTool` |
| `packages/agent/src/daemon/runtime.ts` | `initAgent()` lädt Skills, baut Hot-Set, injiziert in System-Prompt, registriert skill tools |
| `packages/agent/src/index.tsx` | In-Process-Mode lädt ebenfalls Skills und injiziert Hot-Set |
| `packages/agent/src/cli/help.ts` | `doctor` Command in Help-Text aufgenommen |
| `packages/agent/src/index.tsx` | `doctor` Subcommand registriert, knownCommands aktualisiert |

## Feature-Details

### Skill-Format

```
$HARNESS_HOME/skills/<skill-name>/skill.md
```

Frontmatter:
- `name` (required, muss Ordnername matchen, lowercase-hyphenated)
- `description` (required, soll "Use when:" / "Don't use when:" enthalten)
- `level` (required: `atom` | `molecule`)
- `requires` (optional, comma-separated Skill-Namen, max. Tiefe 1)
- `status` (optional, default `active`: draft|active|stale|archive)
- `pinned` (optional, default false)
- `routable` (optional, default true)

Optionale Subdirectories: `scripts/`, `references/`, `evals/`

### Hot-Set (Tier-0)

- Pinned skills (active only) → immer im System-Prompt
- Top-N nach telemetry.uses → im System-Prompt bis Token-Budget (~2k)
- Nur `name` + `description`, nicht der volle Body
- `draft`/`stale`/`archive` nie im Hot-Set

### Tools

- `load_skill(name)` → volle skill.md + Hinweis auf scripts/references + Telemetry-Update
- `find_skill(query)` → QMD searchLex + searchVector + RRF über name+description aller routbaren Skills; fallback keyword search
- Atome mit eingehenden `requires` sind nicht routbar (nur via Parent erreichbar)

### Telemetry

`$HARNESS_HOME/skills/_telemetry.json` — pro Skill: `uses`, `last_used`, `patches`, `pinned`

### harness doctor

- Frontmatter-Validierung
- requires-Ziele existieren + Tiefe ≤ 1
- Token-Warnung (>1200 Tokens)
- Dark skills (active aber nie geladen)

## Tests

- 40 Skill-Tests: Frontmatter-Parsing (8), Loader (7), requires-Validation (3), Routability (2), Hot-Set (8), Telemetry (5), load_skill Tool (3), find_skill Tool (3)
- Alle 371 Core-Tests ✓
- Alle 255 Agent-Tests ✓
- tsc clean ✓
