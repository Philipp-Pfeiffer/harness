# Inbetriebnahme auf einem anderen Device

**Stand:** 2026-07-24
**Scope:** Schritt-für-Schritt, um Harness auf einer frischen Maschine laufenzubekommen — ohne Secrets in Git zu committen.

---

## Voraussetzungen

- **Node.js** ≥ 20 (≥ 22 empfohlen für QMD/SQLite-Erweiterungen)
- **pnpm** ≥ 9
- **Linux** mit `sqlite3` dev headers (benötigt von `sqlite-vec` über QMD)
- Git-Zugang zum Repo

---

## 1. Code auschecken

```bash
git clone <repo-url>
cd harness
```

## 2. Dependencies installieren

```bash
pnpm install
```

## 3. Build

```bash
pnpm -r build
```

---

## 4. Harness Home einrichten

Harness trennt durables Substrat (`HOME`) von ephemeralen Runtime-Daten (`STATE`):

| Kategorie | Pfad | Inhalt |
|---|---|---|
| `HOME` | `$HARNESS_HOME` (default `~/harness`) | `core.md`, `AGENTS.md`, `config.json`, `.env`, `memory/`, `sources/`, `skills/` |
| `STATE` | `$HARNESS_STATE` (default `~/.harness`) | `sessions/`, `metrics/`, `index/`, `logs/`, `daemon.sock` |

**Auf einem neuen Device anlegen:**

```bash
mkdir -p ~/harness
```

Oder mit Custom-Home:

```bash
export HARNESS_HOME=/pfad/zum/harness-home
```

Siehe [`topology.md`](topology.md) für Details zur Pfad-Resolution.

---

## 5. Secrets anlegen

Alle API-Keys leben zentral in **`$HARNESS_HOME/.env`**, nie im Repo. Die Datei ist in `.gitignore` und in `$HARNESS_HOME/.gitignore` eingetragen.

```bash
cp .env.example ~/harness/.env
chmod 600 ~/harness/.env
```

Dann `$EDITOR ~/harness/.env` öffnen und befüllen, z. B.:

```bash
OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# OPENROUTER_API_KEY=sk-or-v1-...
WHATSAPP_WHITELIST_NUMBER=4915112345678
# ASSEMBLYAI_API_KEY=...
```

Secrets dürfen nicht committet werden. Falls `~/harness` ein eigenes Git-Repo ist, muss `.env` dort ebenfalls ignored sein.

Siehe [`docs/changes/feat-centralized-secrets.md`](../changes/feat-centralized-secrets.md).

---

## 6. Config anlegen

Die Runtime-Config liegt in **`$HARNESS_HOME/config.json`**. Beispiel kopieren und anpassen:

```bash
cp harness.config.example.json ~/harness/config.json
```

Provider-Keys werden über `env:VAR_NAME` referenziert, nicht im Klartext:

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
  "defaultModel": {...}
}
```

Die Config-Lookup-Reihenfolge ist:

1. `--configPath` (CLI-Flag)
2. `$HARNESS_HOME/config.json`
3. `<cwd>/harness.config.json` (legacy, deprecated)
4. `$XDG_CONFIG_HOME/harness/config.json`
5. `~/.harness/config.json` (legacy)

`harness.config.json` im Repo-Root ist in `.gitignore` und darf keine echten Keys enthalten.

---

## 7. Daemon starten

### Manuell

```bash
harness daemon start
```

Status prüfen:

```bash
harness daemon status
```

### Als systemd User-Service

```bash
harness daemon install
systemctl --user daemon-reload
systemctl --user enable harness-daemon
systemctl --user start harness-daemon
```

Das Unit-File lädt Secrets über `EnvironmentFile=%h/harness/.env`.

Siehe [`daemon.md`](daemon.md).

---

## 8. TUI starten

```bash
# Mit Daemon (empfohlen)
harness chat

# Oder in-process (ohne Daemon)
harness
```

---

## Migration von einem anderen Device

1. **Code:** Repo neu clonen oder vorhandenen Checkout kopieren.
2. **Wissen:** `$HARNESS_HOME/memory/`, `$HARNESS_HOME/sources/` und `$HARNESS_HOME/core.md` kopieren (z. B. via `rsync` oder Git-Repo für HOME).
3. **Config & Secrets:** `$HARNESS_HOME/config.json` und `$HARNESS_HOME/.env` manuell übertragen — **nicht** über Git.
4. **State:** Muss nicht migriert werden. `$HARNESS_STATE` ist regenerierbar; ggf. `harness reindex` ausführen.

Für Legacy-Setups gibt es `harness migrate-home`, das `cwd/core.md`, `cwd/AGENTS.md`, `cwd/harness.config.json`, `cwd/memory/` und `cwd/sources/` nach `$HARNESS_HOME` verschiebt.

---

## Was niemals gepusht wird

- `.env` oder `.env.*`
- `harness.config.json` mit echten Keys
- `$HARNESS_HOME/` (liegt außerhalb des Code-Repos)
- `$HARNESS_STATE/` (ephemeral)

Im Repo liegen nur Beispiel-Dateien ohne echte Secrets:

- `.env.example`
- `harness.config.example.json`

---

## Troubleshooting

### Daemon lädt Env-Variablen nicht

Bei systemd:

```bash
systemctl --user cat harness-daemon
# EnvironmentFile=%h/harness/.env prüfen
```

Bei manuellem Start oder Restart-Skript:

```bash
cat /proc/$(pgrep -f "harness daemon run")/environ | tr '\0' '\n' | grep -E "API_KEY|WHATSAPP"
```

Falls Variablen fehlen: `scripts/restart-daemon.sh` lädt `~/.harness_env`. Siehe [`docs/changes/whatsapp-env-loading-postmortem.md`](../changes/whatsapp-env-loading-postmortem.md).

### Config wird nicht gefunden

```bash
HARNESS_HOME=~/harness harness daemon status
```

prüft, ob der richtige Home-Pfad verwendet wird.
