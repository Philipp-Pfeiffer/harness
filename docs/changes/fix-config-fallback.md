# fix: Inkonsistente Fallback-Semantik beim Config-Laden

## Problem

`loadConfig()` in `packages/core/src/config.ts` behandelte fehlende und kaputte Config-Dateien inkonsistent:

- **Parse-Errors (invalid JSON)** wurden im selben catch-Block wie "File not found" (ENOENT) behandelt und stillschweigend übersprungen. Ein Nutzer mit einem JSON-Syntaxfehler in seiner Config-Datei erfuhr nie, warum seine Konfiguration nicht geladen wurde — stattdessen wurde einfach die nächste Candidate-Datei probiert oder Defaults verwendet.
- **Permission-Denied und andere Lese-Fehler** wurden ebenfalls Stillschweigend geschluckt.
- **`source`-Feld** wurde bei "No config found" nicht gesetzt (undefined), obwohl es bei anderen Fallback-Pfaden gesetzt wurde.

## Befund

Die catch-Block-Struktur (Zeile 209-216 vor dem Fix) war:

```typescript
catch (err) {
  if (err instanceof Error && err.message.startsWith("Missing environment variable")) {
    throw err;
  }
  // try next candidate  ← whispered all errors including JSON parse errors
}
```

Keine Differenzierung zwischen ENOENT (Datei existiert nicht → try next, korrekt) und JSON-Parse-Errors (Datei existiert, ist aber kaputt → sollte als Fehler gemeldet werden).

## Fix

Vereinheitlichte Strategie in `loadConfig()`:

1. **File not found (ENOENT)** → `continue` zum nächsten Candidate (verhalten unverändert).
2. **Permission-Denied / andere Lese-Fehler** → Fehler in `errors[]` sammeln, nächsten Candidate probieren. Am Ende in der Fehlermeldung sichtbar.
3. **Parse-Error (invalid JSON)** → Sofortiger Return mit Defaults + klarer Fehlermeldung `"Failed to parse config at <path>: <error>"` und gesetztem `source`-Feld. Kein stillschweigendes Überspringen zur nächsten Candidate-Datei.
4. **Missing env-var reference** → wirft weiterhin hart (unverändert).
5. **Missing keys** → Defaults für fehlende Keys (unverändert).
6. **No config found anywhere** → Defaults + `"No config found, using default model"` mit `source: undefined`. Wenn Lese-Fehler auftraten, werden diese aufgeführt.

Der catch-Block wurde in drei separate try/catch-Blöcke aufgespalten: einen für `readFile` (ENOENT-Erkennung), einen für `JSON.parse` (Parse-Error als sichtbarer Fehler), und `resolveConfigValues` läuft im selben Scope (env-var-Errors propagieren weiterhin hart).

## Dateien

- `packages/core/src/config.ts` — `loadConfig()` Fallback-Logik vereinheitlicht
- `packages/core/tests/cli/config.test.ts` — 2 neue Tests: Parse-Error zeigt klare Meldung, kein Fallback auf spätere Candidate bei kaputtem JSON

## Tests

`npx vitest run` — 671 Tests in 56 Files, alle grün.
