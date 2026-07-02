# Tool: web_search

**Status:** Implementiert (Phase 1)
**Datei:** `src/tools/web_search.ts`
**Provider:** `src/tools/webSearch/`

## Überblick

Sucht das Web und liefert eine kurze Liste mit Titel, URL und Snippet. Keine Full-Pages — dafür `web_fetch` verwenden.

## Parameter

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `query` | `string` | Ja | Suchbegriff. |
| `k` | `integer` | Nein | Maximale Trefferzahl (1-20, default 5). |

## Output

```xml
<web_content url="web_search://TypeScript%20tutorials" untrusted="true">
provider: brave

1. [Titel 1](https://example.com/1)
   Snippet 1...

2. [Titel 2](https://example.com/2)
   Snippet 2...
</web_content>
```

## Provider-Config

Provider werden in `config.json` unter `web_search.providers` als geordnete Liste konfiguriert:

```json
{
  "web_search": {
    "providers": [
      { "type": "searxng", "endpoint": "https://search.example.com" },
      { "type": "brave", "apiKey": "env:BRAVE_API_KEY" },
      { "type": "tavily", "apiKey": "env:TAVILY_API_KEY" }
    ],
    "maxResults": 8,
    "snippetBudget": 400,
    "totalBudget": 6000
  }
}
```

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `type` | `string` | `searxng`, `brave` oder `tavily`. |
| `apiKey` | `string` | Für `brave` und `tavily` erforderlich. Env-Substitution `${...}` wird aufgelöst. |
| `endpoint` | `string` | Für `searxng` erforderlich. |
| `enabled` | `boolean` | Optional. `false` deaktiviert den Provider. |

## Fallback-Kette

- Provider[0] wird zuerst versucht.
- Bei Fehler, Quota oder 429 → Provider[1], dann [2], …
- Wenn alle scheitern: klare Fehlermeldung.
- Der genutzte Provider wird geloggt.

## Token-Budgets

- `maxResults`: Obergrenze für Trefferzahl (default 10).
- `snippetBudget`: Maximale Zeichen pro Snippet (default 400).
- `totalBudget`: Maximale Zeichen für das gesamte Tool-Result (default 6.000).

## Fehlerfälle

| Input | Output |
|-------|--------|
| Keine Provider konfiguriert | `web_search failed: No web_search providers configured.` |
| Alle Provider down | `web_search failed: All web_search providers failed: ...` |

## Adapter-Liste

| Adapter | Type | Authentifizierung |
|---------|------|-------------------|
| SearXNG | `searxng` | keyless/free |
| Brave Search | `brave` | API-Key |
| Tavily | `tavily` | API-Key |

Neue Provider erfordern nur einen neuen Adapter + Config-Eintrag.
