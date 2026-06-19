# Harness Home / State Audit

**Datum:** 2026-06-19  
**Baseline-Tests:** 263 passed (6 Test-Files mit `node-pty`-Native-Modul-Ladefehler, pre-existing)  
**Ziel:** Inventar aller Pfad-Referenzen im Code-Repo, Kategorisierung in HOME | STATE | CODE.

---

## Inventar-Tabelle

| Konsument | Aktueller Pfad / Mechanismus | Kategorie | Datei:Zeile | Anmerkung |
|---|---|---|---|---|
| **core.md** | `process.cwd()` / `HARNESS_PROJECT_ROOT` → `core.md` | HOME | `src/core/coreMemory.ts:16–17` | Wird ins System-Prompt injiziert |
| **AGENTS.md** | Wird nicht direkt geladen; Referenz in `core.md` Working-Protocol | HOME | `core.md:14`, `tests/core/coreMemory.test.ts:63` | Soll mit `core.md` nach HOME wandern |
| **memory/** | `HARNESS_MEMORY_PATH` env → `expandHome`, sonst `<projectRoot>/memory` | HOME | `src/core/memoryFolders.ts:34–36` | Persönliche Notizen |
| **sources/** | `HARNESS_SOURCES_PATH` env → `expandHome`, sonst `<projectRoot>/sources` | HOME | `src/core/memoryFolders.ts:38–40` | Externe Quellen |
| **_inbox.md** | `HARNESS_INBOX_PATH` env, sonst `<memoryPath>/_inbox.md` | HOME | `src/core/memoryFolders.ts:42–44` | Quick-Notes |
| **prompts/** | `import.meta.url` → repo-relative `../prompts` | CODE → HYBRID | `src/prompts.ts:5` | Siehe offener Grenzfall unten |
| **config.json** | Lookup: `configPath` → `cwd/harness.config.json` → `$XDG_CONFIG_HOME/harness/config.json` → `~/.harness/config.json` | HYBRID → HOME | `src/cli/config.ts:21–37` | Modelle & Provider |
| **metrics/** | `HARNESS_METRICS_DIR` env → `~/.harness/metrics` | STATE | `src/core/metrics.ts:54–57` | JSONL-Turn/Tool/Error-Logs |
| **QMD DB (index)** | `HARNESS_QMD_DB_PATH` env → `<cwd>/.qmd/index.sqlite` | STATE | `src/index.tsx:23–27` | SQLite + FTS5 + vec |
| **embed-model marker** | `<dirname(dbPath)>/.embed-model` | STATE | `src/core/memoryService.ts:208` | Cache-Invalidierung |
| **workspace/** | `<projectRoot>/workspace` + `process.chdir()` | WORKSPACE | `src/index.tsx:18,36` | Bleibt cwd-basiert |
| **Session-Tracking (process)** | In-memory `Map<string, Session>` in `ProcessSupervisor` | IN-MEMORY | `src/tools/processSupervisor.ts:27` | Keine Datei-Persistenz |
| **Session-Logs** | *Nicht vorhanden* | — | — | Keine dedizierte Session-Log-Datei gefunden |

### Session-Logging Status (explizite Klärung)

**Aktuell existiert kein Session-Logging.** Es gibt keine Datei, in die Turn-Historien oder
Session-Metadaten geschrieben werden. Das `ProcessSupervisor`-`sessions`-Map ist rein
in-memory (Trackt laufende/nach Ende beibehaltene Background-Prozesse, keine Agent-Sessions).

Metrics-Events (Turn/Tool/Error) werden in `$HARNESS_STATE/metrics/` geschrieben, aber das
ist kein Session-Log — es sind aggregierte Zähler/Timings ohne historischen Verlauf.

**Vorgabe für die Zukunft:** Wenn ein Session-Logging-Mechanismus gebaut wird (Phase A.5),
MUSS er von Anfang an `paths.sessions` (aus `resolveHarnessPaths()`) nutzen — **keine eigene
Pfadlogik, kein `process.cwd()`, keine `homedir()`-Direktzugriffe.** Das `paths.sessions`
Verzeichnis (`$HARNESS_STATE/sessions/`) ist bereits in `HarnessPaths` definiert und wird
von `ensureDirs()` angelegt.

---

## Env-Variablen-Übersicht

| Variable | Wo definiert | Verwendung | Zukünftiger Status |
|---|---|---|---|
| `HARNESS_PROJECT_ROOT` | `src/index.tsx:16` | Root für `core.md`, `memory/`, `sources/`, `config.json` | **Deprecated** — ersetzt durch `HARNESS_HOME` |
| `HARNESS_MEMORY_PATH` | `src/core/memoryFolders.ts:34` | Override für `memory/` | **Deprecated** — ersetzt durch `HARNESS_HOME/memory` |
| `HARNESS_SOURCES_PATH` | `src/core/memoryFolders.ts:38` | Override für `sources/` | **Deprecated** — ersetzt durch `HARNESS_HOME/sources` |
| `HARNESS_INBOX_PATH` | `src/core/memoryFolders.ts:42` | Override für `_inbox.md` | **Deprecated** — ersetzt durch `HARNESS_HOME/memory/_inbox.md` |
| `HARNESS_QMD_DB_PATH` | `src/index.tsx:23` | Override für QMD-DB-Pfad | **Deprecated** — ersetzt durch `<HARNESS_STATE>/index/` |
| `HARNESS_METRICS_DIR` | `src/core/metrics.ts:54` | Override für Metrics-Dir | **Deprecated mit Alias** → `HARNESS_STATE` oder `HARNESS_METRICS_DIR` als Fallback |
| *(neu)* `HARNESS_HOME` | — | Durables Substrat | **Neu einführen** |
| *(neu)* `HARNESS_STATE` | — | Ephemeraler State | **Neu einführen** |

---

## Offene Grenzfälle

### 1. `prompts/` — Layer-Templates
**Status:** Rein Code-Repo (`src/prompts.ts:5` via `import.meta.url`).

**Verbindliche Entscheidung:**
- System-Prompts (Identity / Safety / Tool-Guidance / Layer-Templates) sind **Architektur** und leben ausschließlich unter `prompts/` im Code-Repo.
- Es gibt **keinen** `$HARNESS_HOME/prompts/`-Override und keine Home-Lookup-Kette für Prompts.
- `HarnessPaths` enthält kein `prompts`-Feld; Prompt-Pfade werden code-relativ aufgelöst.
- **Bewusst nicht gebaut** — Prompts bleiben Code.

### 2. `harness.config.json` im Repo-Root
**Status:** Im Repo-Root liegt eine `harness.config.json` mit Model-Liste. Laut aktuellem Config-Loader hat `cwd/harness.config.json` Vorrang vor `~/.harness/config.json`.

**Empfohlene Lösung:**
- `cwd/harness.config.json` aus der Lookup-Kette entfernen (oder auf letzte Priorität setzen).
- Primärer Ort: `$HARNESS_HOME/config.json`.
- Fallback: `$XDG_CONFIG_HOME/harness/config.json` → `~/.harness/config.json` (Deprecation-Phase).

### 3. `AGENTS.md`
**Status:** Wird nicht programmatisch geladen, sondern in `core.md` referenziert.

**Empfohlene Lösung:** Mit `core.md` nach `$HARNESS_HOME/AGENTS.md` verschieben. `core.md` referenziert es ggf. relativ (beide im selben Dir).

### 4. `workspace/`
**Status:** Explizit ein cwd-Konzept. `src/index.tsx:18` erstellt `<cwd>/workspace` und `chdir` hinein.

**Empfohlene Lösung:** Bleibt unverändert. Nicht HOME/STATE, sondern aktiver Arbeitsbereich.

---

## Nächste Schritte

1. **Schritt 1:** `src/config/paths.ts` bauen (einzige Pfad-Quelle).
2. **Schritt 2:** Konsumenten einzeln migrieren:
   1. `coreMemory.ts` → `paths.core`
   2. `memoryFolders.ts` → `paths.memory`, `paths.sources`, `paths.inbox`
   3. `metrics.ts` → `paths.metrics` (mit `HARNESS_METRICS_DIR`-Alias)
   4. `index.tsx` (QMD-DB) → `paths.index`
   5. `prompts.ts` → bleibt code-relativ (kein Home-Override, bewusst nicht gebaut)
   6. `config.ts` → `paths.config`
3. **Schritt 3:** `harness migrate-home` Command.
4. **Schritt 4:** Doku & Guardrails.
