# Harness Topology: HOME vs. STATE vs. CODE

**Stand:** 2026-06-19  
**Scope:** Runtime-State-Trennung — `$HARNESS_HOME` (durable) vs. `$HARNESS_STATE` (ephemeral) vs. Code-Repo

---

## Überblick

```
┌─────────────────────────────────────────────────────────────┐
│                      CODE-REPO (Git)                        │
│  src/           — TypeScript-Logik                          │
│  prompts/       — Layer-Templates (Repo-Default)           │
│  tests/         — Test-Suite                                │
│  docs/          — Doku                                      │
└─────────────────────────────────────────────────────────────┘
        │ resolveHarnessPaths() injiziert
        ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│   $HARNESS_HOME          │  │   $HARNESS_STATE              │
│   (durable, portable)     │  │   (ephemeral, regenerierbar)  │
│                          │  │                               │
│  core.md                 │  │  sessions/                    │
│  AGENTS.md               │  │  metrics/      (JSONL-Logs)   │
│  config.json             │  │  metrics/      (JSONL-Logs)   │
│  memory/    (Notizen)    │  │  index/        (QMD SQLite)   │
│  sources/   (Quellen)    │  │                               │
│  skills/                 │  │  Default: ~/.harness/         │
│                          │  │  oder: $XDG_STATE_HOME/harness│
│  Default: ~/harness      │  │  Rule: Nicht in Git einchecken│
│  Eigenes Git-Repo         │  │                               │
└──────────────────────────┘  └──────────────────────────────┘
        ▲                                    ▲
        │                                    │
   Mehrere Agent-Prozesse teilen sich        Regenerierbar via
   denselben $HARNESS_HOME — unabhängig      `harness reindex` oder
   vom cwd/Checkout                           Neustart
```

---

## Begriffsklärung: Workspace vs. Home

| Begriff | Bedeutung | Pfad-Quelle |
|---------|-----------|-------------|
| **Workspace** | Das `cwd`, auf das die File-Tools operieren. `CLI --workspace` / `/cd`. | `process.cwd()` |
| **$HARNESS_HOME** („Home" / „Vault") | Durables Agent-Substrat. Portabel, git-trackbar. | `src/config/paths.ts` → `resolveHarnessPaths()` |
| **$HARNESS_STATE** | Ephemerer Runtime-State. Regenerierbar. | `src/config/paths.ts` → `resolveHarnessPaths()` |

**Vorsicht:** „Workspace" und „Home" werden **niemals** vermischt. Der Workspace ist das cwd des Users; Home ist der durables Agent-Speicher.

---

## Pfad-Resolution (`src/config/paths.ts`)

**Einzige Quelle für alle Pfade.** Niemand sonst baut Pfade selbst.

### HARNESS_HOME
```
--home CLI-Flag → $HARNESS_HOME env → Default ~/harness
```

### HARNESS_STATE
```
$HARNESS_STATE env → $XDG_STATE_HOME/harness → Default ~/.harness
```

### Dependency Injection
`resolveHarnessPaths()` gibt ein `HarnessPaths`-Objekt zurück. Es wird einmalig beim Prozess-Start erzeugt und per DI durchgereicht. Tests können einen Temp-Dir injizieren.

---

## Config-Loader Lookup-Reihenfolge

1. `--configPath` (CLI-Flag)
2. `$HARNESS_HOME/config.json` (primär)
3. `<cwd>/harness.config.json` (legacy, deprecated)
4. `$XDG_CONFIG_HOME/harness/config.json`
5. `~/.harness/config.json` (legacy Fallback)

---

## Migration von Legacy-Pfaden

`harness migrate-home` verschiebt vorhandenes Substrat:
- `cwd/core.md` → `$HARNESS_HOME/core.md`
- `cwd/AGENTS.md` → `$HARNESS_HOME/AGENTS.md`
- `cwd/harness.config.json` → `$HARNESS_HOME/config.json`
- `cwd/memory/` → `$HARNESS_HOME/memory/`
- `cwd/sources/` → `$HARNESS_HOME/sources/`

**Index wird NICHT verschoben** → `harness reindex` regeneriert den Cache.
Idempotent + `--dry-run` verfügbar.

---

## Bewusst nicht gebaut

### prompts/ (Layer-Templates) — KEIN Home-Override
System-Prompts (Identity / Safety / Tool-Guidance / Layer-Templates) sind **Architektur** und leben ausschließlich unter `prompts/` im Code-Repo. Es gibt bewusst **keinen** `$HARNESS_HOME/prompts/`-Override und keine Home-Lookup-Kette für Prompts. `HarnessPaths` enthält kein `prompts`-Feld; Prompt-Pfade werden code-relativ aufgelöst (`src/prompts.ts` via `import.meta.url`).

### Skills
`$HARNESS_HOME/skills/` ist vorgesehen, aber noch nicht belegt.
