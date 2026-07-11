# Zentrale Secrets-Verwaltung mit `env:VAR_NAME`

**Date:** 2026-07-02
**Branch:** `feature/webfeatures`
**Scope:** `src/cli/config.ts`, `tests/cli/config.test.ts`, `systemd/harness.service`, `~/harness/config.json`, `~/harness/.env`

---

## Motivation

API-Keys dürfen nicht in Config-Dateien im Klartext stehen und schon gar nicht in Git landen. Alle Secrets sollen zentral in `$HARNESS_HOME/.env` liegen, während die Config-Dateien nur `env:VAR_NAME`-Referenzen enthalten. Das gilt für LLM-Provider, Web-Search-Provider und zukünftige Tools.

---

## Regeln

1. **Secrets leben ausschließlich in `$HARNESS_HOME/.env`.**
   - Nicht in `$HARNESS_STATE` — STATE ist ephemer/löschbar, Keys sind es nicht.
   - Dateiberechtigung `600`.
   - In `.gitignore` aufgenommen.

2. **Config-Dateien enthalten niemals Klartext-Keys.**
   - Stattdessen: `apiKey = "env:BRAVE_API_KEY"`.
   - Der Resolver ersetzt den Wert beim Laden durch den Inhalt der Umgebungsvariable.

3. **Fehlende Variablen führen zu einem klaren Fehler.**
   - `Missing environment variable referenced by config: VAR_NAME`.
   - `loadConfig()` bricht ab, statt stillschweigend zur Default-Config zurückzufallen.

4. **Keys tauchen nie in Logs/Metrics/Transcripts auf.**
   - Der Key wird nur an `pi-ai stream()` und HTTP-Headers weitergegeben.
   - Keine Logging-Ausgabe des Keys im Harness-Code.

---

## Änderungen

### 1. Config-Resolver (`src/cli/config.ts`)

- `expandEnvVars()` umbenannt in `resolveConfigValues()`.
- Neue Hilfsfunktion `resolveConfigString()`:
  - Erkennt `env:VAR_NAME` als vollständigen Wert und ersetzt ihn.
  - Behält Legacy-Support für Inline `${VAR}`-Substitution.
- `loadConfig()` wirft Fehler bei fehlenden `env:`-Referenzen statt zum nächsten Config-Candidate zu springen.

### 2. Tests (`tests/cli/config.test.ts`)

- Test: `env:VAR_NAME` wird korrekt aufgelöst.
- Test: Fehlende `env:VAR_NAME`-Referenz führt zu klarem Fehler.
- Bestehende `${VAR}`-Tests weiterhin grün.

### 3. systemd Unit-File (`systemd/harness.service`)

```ini
[Unit]
Description=Harness Agent Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /home/p-pfeiffer/dev/harness/dist/index.js
WorkingDirectory=/home/p-pfeiffer/dev/harness
EnvironmentFile=%h/harness/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

`EnvironmentFile=%h/harness/.env` stellt sicher, dass der Daemon (auch ohne interaktive Shell) alle Secrets geladen bekommt.

### 4. Migration der bestehenden Keys

**Vorher:**
- `~/harness/config.json`: NeuralWatt-Key im Klartext.
- `~/.harness/config.json`: Web-Config mit `${TAVILY_API_KEY}`.
- `~/.harness/.env`: Tavily-Key im Klartext.

**Nachher:**
- `~/harness/config.json`: alle Provider-Keys als `env:...`.
- `~/harness/.env`: alle API-Keys zentral.
- `~/.harness/config.json` und `~/.harness/.env`: entfernt/bereinigt.

**Aktuell in `~/harness/.env`:**
- `MINIMAX_API_KEY`
- `KIMI_API_KEY`
- `NEURALWATT_API_KEY`
- `TAVILY_API_KEY`

**Aktuell in `~/harness/config.json`:**
```json
{
  "providers": {
    "neuralwatt": {
      "type": "openai",
      "baseUrl": "https://api.neuralwatt.com/v1",
      "apiKey": "env:NEURALWATT_API_KEY"
    }
  },
  "models": [...],
  "defaultModel": {...},
  "web_search": {
    "providers": [
      { "type": "tavily", "apiKey": "env:TAVILY_API_KEY" }
    ]
  }
}
```

### 5. `$HARNESS_HOME/.gitignore`

```gitignore
.env
```

Schützt `~/harness/.env` gegen versehentliches Git-Tracking, falls `$HARNESS_HOME` jemals initialisiert wird.

---

## Verifikation

- `pnpm run typecheck` ✅
- `pnpm run build` ✅
- `npx vitest run tests/cli/config.test.ts` ✅ (8 tests)

---

## Offene Punkte / Nacharbeit

1. **Installationsskript:** Ein `scripts/install-systemd.sh` könnte das Unit-File nach `~/.config/systemd/user/` kopieren und `systemctl --user enable --now harness` ausführen.
2. **Mehrere Keys pro Provider:** `web_search.providers` unterstützt bereits mehrere Tavily/Brave-Einträge mit unterschiedlichen `env:...`-Referenzen.
3. **Browser-Tools:** Neue Tools müssen Secrets ebenfalls über `env:...` in Config + `$HARNESS_HOME/.env` beziehen.
