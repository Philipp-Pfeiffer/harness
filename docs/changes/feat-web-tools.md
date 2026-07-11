# Web-Tools: web_search + web_fetch mit Provider-Fallback und Content-Safety

**Date:** 2026-07-02
**Branch:** `feature/webfeatures`
**Scope:** `src/tools/`, `src/cli/config.ts`, `src/core/systemPrompt.ts`, `src/cli/App.tsx`, `prompts/`, `docs/tools/`
**Baseline:** `main`

---

## Motivation

Das Harness soll generische Web-Tools bekommen, um den Agenten gezielt mit öffentlichen Web-Inhalten zu versorgen — ohne Browser-Engine, ohne Full-Page-Dumps ins Transcript. Wichtigste Anforderungen neben der Funktion: Provider-agnostische Fallback-Kette (kein Single Point of Failure) und ein Security-Layer gegen SSRF sowie Prompt-Injection aus Web-Inhalten.

---

## Architektur-Entscheidungen

### 1. Config: JSON statt TOML

Die ursprüngliche Anforderung nannte `~/.harness/providers.toml`. Das Projekt verwendet jedoch bereits JSON für Provider-/Modell-Config (`src/cli/config.ts`, `loadConfig`) und hat keine TOML-Dependency. Statt ein zweites Format + Parser einzuführen, wurden die Web-Provider in die bestehende JSON-Config integriert.

**Ort der Runtime-Config:** `$HARNESS_HOME/config.json` bzw. `~/.harness/config.json` (legacy fallback), konsistent mit `loadConfig`.

**Offene Entscheidung (siehe unten):** Ob Web-Config und Secrets generell in `$HARNESS_HOME` (durable, portabel) oder `$HARNESS_STATE` (ephemeral, maschinen-lokal) liegen sollen.

### 2. Secrets: `env:VAR_NAME`-Referenzen + `$HARNESS_HOME/.env`

API-Keys werden in der JSON-Config als `env:VAR_NAME` referenziert und zur Laufzeit via `resolveConfigValues()` aus den Environment-Variablen aufgelöst. Die `.env`-Datei wird beim Start aus `$HARNESS_HOME/.env` und dann aus `<cwd>/.env` geladen.

**Aktueller Stand (nach Secret-Migration):**
- Alle API-Keys liegen in `$HARNESS_HOME/.env` (z.B. `~/harness/.env`).
- `~/harness/config.json` enthält nur `env:NEURALWATT_API_KEY`, `env:TAVILY_API_KEY`, etc.
- `$HARNESS_HOME/.env` ist via `~/harness/.gitignore` gegen versehentliches Git-Tracking geschützt.
- Beim systemd-Start wird `EnvironmentFile=%h/harness/.env` im Unit-File verwendet.

### 3. Safety-Layer: konditional + Tool-Level-Spotlighting

- Der Web-Content-Safety-Prompt wird nur injiziert, wenn `web_fetch` oder `web_search` im aktiven Tool-Set sind.
- Die `<web_content url="…" untrusted="true">`-Wrapperung erfolgt in den Tools selbst, nicht im LLM-Layer. Das garantiert, dass Web-Output nie ohne Marker ins Transcript gelangt.

### 4. Provider-Fallback

- Gemeinsames Interface `SearchProvider { name, search(query, opts) }`.
- Adapter für SearXNG (keyless/free), Brave, Tavily.
- Mehrere Einträge desselben Typs sind erlaubt (z.B. mehrere Tavily-Keys). Sie werden automatisch als `tavily-1`, `tavily-2`, … oder mit explizitem `name` benannt.
- `fallbackSearch()` versucht Provider in Config-Reihenfolge; bei Fehler/Quota/429 wird zum nächsten gewechselt.

---

## Änderungen

### 1. Config-Layer (`src/cli/config.ts`)

Neue Typen:

```ts
type WebSearchProviderConfig =
  | { type: "searxng"; endpoint: string; name?: string; enabled?: boolean }
  | { type: "brave"; apiKey: string; name?: string; enabled?: boolean }
  | { type: "tavily"; apiKey: string; name?: string; enabled?: boolean };

interface WebConfig {
  web_search?: {
    providers?: WebSearchProviderConfig[];
    maxResults?: number;
    snippetBudget?: number;
    totalBudget?: number;
  };
  web_fetch?: {
    outputCap?: number;
    timeout?: number;
    maxResponseSize?: number;
    redirectLimit?: number;
    allowlist?: string[];
  };
}
```

`loadConfig()` liefert jetzt zusätzlich `webConfig: WebConfig` zurück.

### 2. Search-Provider-Subsystem (`src/tools/webSearch/`)

- `src/tools/webSearch/types.ts` — `SearchHit`, `SearchProvider`, `SearchProviderError`.
- `src/tools/webSearch/providers/searxng.ts` — ruft konfigurierten SearXNG-Endpoint ab.
- `src/tools/webSearch/providers/brave.ts` — Brave Search API.
- `src/tools/webSearch/providers/tavily.ts` — Tavily API.
- `src/tools/webSearch/fallbackSearch.ts` — baut Provider aus Config, führt Fallback-Kette aus, wendet Budgets an.

### 3. `web_search` Tool (`src/tools/web_search.ts`)

Parameter: `query`, `k`.
Rückgabe: Markdown-Liste mit `title`, `url`, `snippet`, eingewickelt in `<web_content url="web_search://…" untrusted="true">`.

### 4. `web_fetch` Tool (`src/tools/web_fetch.ts`)

Parameter: `url`, `line_start`.
Ablauf:
1. URL-Parsing + Schema-Check.
2. DNS-Lookup + IP-Range-Check (localhost, private, link-local).
3. Manuelles Redirect-Handling mit Neu-Prüfung pro Hop.
4. Streambasierte Response-Größenbegrenzung.
5. HTML → Markdown via `turndown`.
6. Zeilenbasierte Pagination + Output-Cap.
7. Wrapper in `<web_content url="…" untrusted="true">`.

SSRF-Härtung liegt in `src/tools/webSecurity.ts`.

### 5. Web-Content-Safety Layer

- `prompts/web-content-safety.md` — Safety-Anweisung für Web-Inhalte.
- `src/core/systemPrompt.ts` — `buildSystemPrompt({ basePrompt, coreMemoryRaw, activeToolNames })`, fügt Safety-Prompt nur bei aktiven Web-Tools hinzu.
- `src/cli/App.tsx` — nutzt `buildSystemPrompt()` statt `composeSystemPrompt()` und übergibt die aktiven Tool-Namen.

### 6. Registry + TUI (`src/tools/registry.ts`, `src/cli/App.tsx`)

- `loadTools()` akzeptiert optional `webConfig` und erstellt `web_search` + `web_fetch`.
- `App.tsx` speichert `webConfig` aus `loadConfig` und reicht es an `loadTools()` weiter.

### 7. Dokumentation

- `docs/tools/web_fetch.md`
- `docs/tools/web_search.md`
- `prompts/README.md` — Prompt- & Injection-Register erweitert.

---

## Config-Beispiel

```json
{
  "providers": {
    "neuralwatt": {
      "type": "openai",
      "baseUrl": "https://api.neuralwatt.com/v1",
      "apiKey": "env:NEURALWATT_API_KEY"
    }
  },
  "models": [
    {
      "provider": "neuralwatt",
      "model": "kimi-k2.7-code",
      "alias": "Kimi K2.7 Code",
      "reasoning": true,
      "input": ["text", "image"],
      "contextWindow": 262000,
      "maxTokens": 8192
    }
  ],
  "defaultModel": {
    "provider": "neuralwatt",
    "model": "kimi-k2.7-code",
    "alias": "Kimi K2.7 Code"
  },
  "web_search": {
    "providers": [
      { "type": "searxng", "endpoint": "https://search.example.com" },
      { "type": "brave", "apiKey": "env:BRAVE_API_KEY" },
      { "type": "tavily", "apiKey": "env:TAVILY_API_KEY" },
      { "type": "tavily", "apiKey": "env:TAVILY_API_KEY_2", "name": "tavily-backup" }
    ],
    "maxResults": 8,
    "snippetBudget": 400,
    "totalBudget": 6000
  },
  "web_fetch": {
    "outputCap": 6000,
    "timeout": 15000,
    "maxResponseSize": 2097152,
    "redirectLimit": 5,
    "allowlist": ["intranet.example.com"]
  }
}
```

Mit passender `$HARNESS_HOME/.env` (z.B. `~/harness/.env`):

```bash
NEURALWATT_API_KEY=...
TAVILY_API_KEY=...
TAVILY_API_KEY_2=...
BRAVE_API_KEY=...
```

---

## Tests

Neue Testdateien:

- `tests/tools/web_search.test.ts` — Provider-Aufbau, Fallback-Kette, Budgets, Multi-Key-Fallback, Wrapper.
- `tests/tools/web_fetch.test.ts` — Wrapper, Pagination, Output-Cap, SSRF-Blocking, Redirect-Blocking.
- `tests/tools/webSecurity.test.ts` — localhost, private IPs, file://, Allowlist.
- `tests/core/systemPrompt.test.ts` — konditionaler Safety-Layer.

Bestehende `tests/cli/config.test.ts` läuft weiterhin grün.

---

## Verifikation

- `pnpm run typecheck` ✅
- `pnpm run build` ✅
- Neue Tests grün:
  - `tests/tools/web_search.test.ts` (15 tests)
  - `tests/tools/web_fetch.test.ts` (6 tests)
  - `tests/tools/webSecurity.test.ts` (12 tests)
  - `tests/core/systemPrompt.test.ts` (4 tests)
  - `tests/cli/config.test.ts` (6 tests)

Vorbestehende Fehler (nicht durch diesen Branch):
- `tests/prompts.test.ts` („system-prompt snapshot“ erwartet veraltetes „Terminal-UI“)
- `tests/cli/non-tty.test.ts` (dotenv-Output wird nicht unterdrückt)

---

## Entscheidung: Secrets in HOME, Config in HOME

Laut Projekt-Topologie:

| Kategorie | Pfad | Inhalt | Git? |
|-----------|------|--------|------|
| **HOME** | `$HARNESS_HOME` (Default `~/harness`) | `core.md`, `AGENTS.md`, `config.json`, `memory/`, `sources/`, `skills/` | Eigenes Git |
| **STATE** | `$HARNESS_STATE` (Default `~/.harness`) | `sessions/`, `metrics/`, `index/` | Nein |

**Entscheidung:** Secrets leben ausschließlich in `$HARNESS_HOME/.env` (nicht in STATE, da STATE ephemer/löschbar ist). Die Config-Dateien enthalten niemals Klartext-Keys, sondern nur `env:VAR_NAME`-Referenzen.

**Aktueller Zustand (nach Migration):**
- `~/harness/config.json` (HOME) enthält die gesamte Config (LLM + Web) mit `env:...`-Referenzen.
- `~/harness/.env` (HOME) enthält alle API-Keys.
- `~/.harness/config.json` und `~/.harness/.env` wurden bereinigt.
- `~/harness/.gitignore` ignoriert `.env`.

---

## Was nicht drin ist

- Keine Browser-Tools / Playwright.
- Keine Cookie-Sessions oder authentifizierten Requests für `web_fetch`.
- Keine separate TOML-Config (JSON-Integration beibehalten).
- Kein Provider-Health-Check beim Start.
