# fix: Security Batch — SSRF DNS-Rebinding + Plaintext API-Key Warning

## Problem / Symptom

Zwei Sicherheitslücken im Harness-Core:

1. **SSRF via DNS-Rebinding (TOCTOU):** `validateUrl()` in `webSecurity.ts` löst den Hostnamen auf und prüft die IP gegen eine Blocklist. Danach übergibt `web_fetch.ts` die URL an `fetch()`, welches einen *erneuten* DNS-Lookup durchführt. Ein Angreifer kann einen DNS-Server betreiben, der bei der ersten Auflösung eine öffentliche IP zurückgibt und bei der zweiten eine private — so umgeht er den SSRF-Schutz und erreicht interne Dienste.

2. **Plaintext API-Keys in Git-Repo:** `config.ts` erlaubt das Speichern von API-Keys als Klartext-Literale in `config.json`. Wenn sich diese Datei in einem Git-Repo befindet, werden die Keys versioniert und potenziell geleaked. Es gab keine Warnung dafür.

## Befund

### SSRF
- `webSecurity.ts:validateUrl()` macht DNS-Lookup + IP-Validierung.
- `web_fetch.ts:fetchWithSecurity()` ruft `validateUrl()` auf, dann `fetch(rawUrl)` — der `fetch()` macht seinen eigenen DNS-Lookup, ohne die validierte IP zu verwenden.
- Die Zeit zwischen Validierung und Verbindungsaufbau ist das TOCTOU-Fenster.

### Config-Warnung
- `config.ts:loadConfig()` lädt Config ohne aufplaintext API-Keys zu prüfen.
- `resolveConfigValues()` ersetzt `env:VAR`-Referenzen durch echte Werte — danach sind Plaintext-Keys und env-referenzierte Keys nicht mehr unterscheidbar.
- Prüfung muss *vor* `resolveConfigValues()` stattfinden.

## Was geändert wurde

### SSRF-Fix

**`packages/core/src/tools/webSecurity.ts`:**
- Neue Funktion `createSecureDispatcher(config?)`: Erstellt einen `undici.Agent` mit einem custom `connect.lookup`, der DNS-Auflösung und IP-Validierung *zur Verbindungszeit* durchführt.
- Der Lookup prüft jede aufgelöste IP gegen die private-IP-Blocklist (gleich wie `validateUrl`), aber erst wenn die eigentliche TCP-Verbindung hergestellt wird — schließt das TOCTOU-Fenster.
- Der Lookup nutzt die bereits bestehenden `isPrivateIp()` und `isAllowedHost()`-Funktionen.

**`packages/core/src/tools/web_fetch.ts`:**
- `createWebFetchTool()` erstellt nun einen Secure Dispatcher pro Tool-Instanz.
- `fetchWithSecurity()` akzeptiert und verwendet den Dispatcher für alle `fetch()`-Aufrufe (inkl. Redirects).
- Der `dispatcher` wird als Option an `fetch()` übergeben.

**`packages/core/package.json`:**
- `undici` als direkte Dependency hinzugefügt (`^7.25.0`), da pnpm strenge Isolation erzwingt.

### Config-Warnung

**`packages/core/src/config.ts`:**
- Neue Hilfsfunktion `hasPlaintextApiKeys(config)`: Prüft rohes (pre-resolution) Config-Objekt auf API-Keys, die keine `env:`- oder `${}`-Referenzen sind.
- Neue Hilfsfunktion `isGitRepo(dir)`: Prüft auf `.git`-Eintrag im Verzeichnis.
- `loadConfig()` gibt nun optional `warning?: string` zurück — gesetzt wenn plaintext API-Keys in einem Git-Repo gefunden werden.
- Warning-Check läuft *vor* `resolveConfigValues()`, um die Unterscheidung zu ermöglichen.

**`packages/agent/src/daemon/runtime.ts`:**
- `loadDaemonConfig()` loggt die Warning über `DaemonLogger.child("config").warn()`.

## Dateien

- `packages/core/src/tools/webSecurity.ts` — `createSecureDispatcher()`, `createSecureLookup()`
- `packages/core/src/tools/web_fetch.ts` — Dispatcher-Integration
- `packages/core/package.json` — undici-Dependency
- `packages/core/src/config.ts` — Plaintext-API-Key-Check, `warning` im Return-Typ
- `packages/agent/src/daemon/runtime.ts` — Warning wird geloggt
- `packages/core/tests/tools/webSecurity.test.ts` — Neue Tests für Dispatcher
- `packages/core/tests/cli/config.test.ts` — Neue Tests für Warning

## Tests

- 14 webSecurity-Tests (12 bestehend + 2 neu für Dispatcher)
- 13 config-Tests (10 bestehend + 3 neu für Warning)
- 683 Tests gesamt, alle grün
