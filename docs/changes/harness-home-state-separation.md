# Change: $HARNESS_HOME / $HARNESS_STATE Separation

**Datum:** 2026-06-19  
**Scope:** Runtime-State aus dem Code-Repo extrahiert — klare Trennung in durables Substrat (HOME) und ephemeralen State (STATE).

## Was geändert wurde

### Neu: `src/config/paths.ts`
- **Einzige Quelle** für alle Harness-Pfade.
- `resolveHarnessPaths(opts?)` → `HarnessPaths`-Objekt mit allen Pfaden.
- `ensureDirs(paths)` → idempotente Directory-Erstellung.
- DI-basiert: wird einmalig beim Start erzeugt und durchgereicht.
- Resolution: `--home` → `$HARNESS_HOME` → `~/harness` (HOME); `$HARNESS_STATE` → `$XDG_STATE_HOME/harness` → `~/.harness` (STATE).

### Migrierte Konsumenten
1. **Core-Loader** (`src/core/coreMemory.ts`): `loadCoreMemoryRaw(corePath?)` — nimmt vollen Pfad statt projectRoot.
2. **Memory + Inbox** (`src/core/memoryFolders.ts`): `ensureInbox(inboxPath)` — schlanke Funktion. `resolveMemoryConfig()` ist deprecated, delegiert auf `resolveHarnessPaths()`.
3. **Metrics** (`src/core/metrics.ts`): `resolveMetricsDir()` nutzt `resolveHarnessPaths()`. `HARNESS_METRICS_DIR` als Alias erhalten (deprecated).
4. **Index/QMD-Cache** (`src/index.tsx`): DB-Pfad jetzt `paths.index/index.sqlite` statt `<cwd>/.qmd/`.
5. **Config-Loader** (`src/cli/config.ts`): `$HARNESS_HOME/config.json` als primäre Candidate hinzugefügt.
6. **statusSummary.ts**: Nutzt bereits `resolveMetricsDir()`, dieser delegiert jetzt auf `paths.metrics`.
7. **Agent** (`src/core/agent.ts`): `resolveMemoryConfig`-Import entfernt; System-Prompt-Default ohne Inbox-Pfad (wird von App.tsx übergeben).

### Neu: `harness migrate-home`
- `src/cli/migrateHome.ts` — verschiebt Legacy-Substrat nach `$HARNESS_HOME`.
- Idempotent + `--dry-run`.
- Index wird nicht verschoben (regenerierbar).
- Migration-Log wird geschrieben.

### App / Entry Point
- `src/index.tsx` — löst `HarnessPaths` auf, injiziert an `App` und `MemoryService`.
- `src/cli/App.tsx` — nimmt `paths` Prop, nutzt `paths.core` und `paths.inbox`.

### Guardrails
- `.gitignore` um `core.md`, `AGENTS.md`, `harness.config.json` erweitert.
- `docs/architecture/topology.md` — Topologie-Diagramm + Workspace-vs-Home-Klärung.
- `AGENTS.md` — Topologie-Sektion hinzugefügt.

### Tests
- `tests/config/paths.test.ts` (neu): 7 Tests für Env-Override, Flag-Override, Default, XDG, Temp-Dir.
- `tests/cli/migrateHome.test.ts` (neu): 7 Tests für dry-run, move, idempotency, no-overwrite.
- `tests/core/memoryFolders.test.ts` (angepasst): Testet `ensureInbox` und `resolveMemoryConfig`-Delegierung.
- `tests/core/coreMemory.test.ts` (angepasst): `corePath` als voller Pfad.
- Alle 277 Tests grün (6 Test-Files mit `node-pty`-Native-Modul-Ladefehler — **pre-existing**, nicht durch diesen Change verursacht; verifiziert auf `main`-Branch).

## Known Issues (pre-existing, nicht durch diesen Change)
- **`node-pty`-Native-Modul-Fehler:** 6 Test-Files schlagen mit `Cannot find module './prebuilds/linux-x64//pty.node'` fehl. Ursache: `pnpm approve-builds` wurde nie erfolgreich ausgeführt, das native Modul wurde nicht kompiliert. Der Fehler existiert identisch auf `main` vor diesem Branch. Er betrifft nur PTY-bezogene Tests — keine Test-Logik wurde durch diesen Refactor beschädigt.

## Offene Punkte
- `skills/`-Verzeichnis in `$HARNESS_HOME/skills/` (noch nicht belegt).
- `harness reindex` Command (noch nicht implementiert; QMD-Warmup überläuft den Cache bei Neustart automatisch).

## Bewusst NICHT gebaut
- **Prompts `$HARNESS_HOME`-Override:** System-Prompts (Identity / Safety / Tool-Guidance / Layer-Templates) sind Architektur und leben ausschließlich unter `prompts/` im Code-Repo. Es gibt bewusst keinen `$HARNESS_HOME/prompts/`-Override und keine Home-Lookup-Kette für Prompts. `HarnessPaths` enthält kein `prompts`-Feld; Prompt-Pfade werden code-relativ aufgelöst (`src/prompts.ts` via `import.meta.url`).
