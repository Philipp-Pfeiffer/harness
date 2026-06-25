# Custom OpenAI-Compatible Provider Support (NeuralWatt)

**Date:** 2026-06-22
**Scope:** `src/cli/config.ts`, `src/core/resolveModel.ts`, `src/core/agent.ts`, `src/cli/App.tsx`
**Baseline:** `main` (347 tests green)

---

## Motivation

Das Harness war auf die fest eingetragenen Provider aus `@mariozechner/pi-ai` beschränkt (minimax, openai, anthropic, etc.). Um einen externen OpenAI-kompatiblen Provider wie NeuralWatt zu nutzen, gab es keinen Weg — die Config unterstützte nur `{ provider, model, alias }` ohne `baseUrl` oder `apiKey`.

## Änderungen

### 1. Config-Schema erweitert (`src/cli/config.ts`)

Neue optionale Felder in der Config:

```json
{
  "providers": {
    "neuralwatt": {
      "type": "openai",
      "baseUrl": "https://api.neuralwatt.com/v1",
      "apiKey": "${NEURALWATT_API_KEY}"
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
  }
}
```

- **`providers`-Block:** Definiert Provider mit `type`, `baseUrl`, `apiKey`. Wird auf alle Modelle dieses Providers vererbt (`mergeProviderDefaults`).
- **`defaultModel`-Block:** Legt fest welches Modell beim Start geladen wird.
- **Modell-Felder:** `api` (`openai-completions` | `openai-responses`), `baseUrl`, `apiKey`, `reasoning`, `input`, `contextWindow`, `maxTokens`, `cost`.
- **`expandEnvVars()`:** `${VAR_NAME}`-Syntax wird in der gesamten Config aufgelöst (rekursiv über Objekte und Arrays).
- **`loadConfig()` Rückgabe:** Jetzt `{ models, providers, defaultModel?, error?, source? }`.

### 2. Custom Provider-Auflösung (`src/core/resolveModel.ts`)

- **`resolveModelFromConfig(config: ConfigModel): ResolvedModel`** — Hauptfunktion für die TUI.
  - Bekannter pi-ai Provider ohne Custom-Fields → delegiert an `resolveModel()`.
  - Unbekannter Provider oder Custom-Fields → baut ein `Model<Api>`-Objekt mit `baseUrl`/`apiKey`/`api` etc.
  - Validiert: `baseUrl` required, `api` muss `openai-completions` oder `openai-responses` sein.
- **`getApiKey(model): string | undefined`** — extrahiert den API-Key aus dem Modell für den Stream.
- **`ResolvedModel`** — `Model<Api> & { apiKey?: string }`.

### 3. Agent-Stream mit API-Key (`src/core/agent.ts`)

```ts
const apiKey = getApiKey(resolvedModel);
const eventStream = stream(resolvedModel, context, { signal, apiKey });
```

Der API-Key wird aus dem Modell extrahiert und an `stream()` durchgereicht. pi-ai nutzt ihn für den OpenAI-Client. Bekannte pi-ai-Provider ohne Custom-Endpoint haben keinen `apiKey` am Modell — pi-ai fällt auf `getEnvApiKey()` zurück.

### 4. TUI: Config-basierte Modellwahl (`src/cli/App.tsx`)

- Beim Start wird `defaultModel` aus der Config geladen und via `resolveModelFromConfig()` aktiviert.
- `/model`-Picker nutzt `resolveModelFromConfig()` statt `resolveModel()` — funktioniert mit Custom Providern.
- Fallback bleibt `minimax/MiniMax-M2.7` wenn keine Config gefunden wird.

### 5. Sicherheit

- `harness.config.json` zu `.gitignore` hinzugefügt.
- `harness.config.json` aus Git-Tracking entfernt (`git rm --cached`).
- `harness.config.example.json` als Template ohne Key im Repo.
- API-Keys können via `${ENV_VAR}` ausgelagert werden.

### 6. Tests

- **`tests/cli/config.test.ts`** — 6 Tests:
  - Provider-Merge (baseUrl/apiKey/api werden vererbt)
  - Environment-Variable-Expansion (`${VAR}`)
  - `defaultModel` mit gemergten Provider-Defaults
  - Bestehende Tests um `harnessHome`-Isolation ergänzt (verhindert lokale Config-Pollution)
- **`tests/core/resolveModel.test.ts`** — 7 Tests:
  - Bekannter Provider ohne Custom-Fields → delegiert
  - Custom Provider mit allen Feldern → baut Model korrekt
  - Custom Provider ohne `baseUrl` → throw
  - Unsupported `api`-Type → throw

## Lookup-Reihenfolge der Config (unverändert)

1. `--config` CLI-Flag
2. `$HARNESS_HOME/config.json` (primär, portabel)
3. `<cwd>/harness.config.json` (legacy)
4. `$XDG_CONFIG_HOME/harness/config.json`
5. `~/.harness/config.json` (legacy fallback)

## Was nicht drin ist

- Keine OAuth-Unterstützung (nur API-Key).
- Keine automatische Modal-Registrierung (Modelle müssen manuell in der Config stehen).
- Kein Provider-Health-Check beim Start.
- `config.ts` hat jetzt eine `harnessHome`-Override-Option für Tests — intern ansonsten identisch.
