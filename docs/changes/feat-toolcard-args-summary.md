# Change: ToolCard Args Summary im Titel

**Commit:** `a1f3b28`  
**Datum:** 2026-06-19  
**Scope:** CLI / TUI

## Übersicht

ToolCards zeigen jetzt im Titel, **womit** das Tool aufgerufen wurde — nicht nur den Tool-Namen.

Zuvor: `▸ exec`  
Jetzt: `▸ exec: $ ls -la`

## Was geändert wurde

- **`ToolItem`-Typ:** Neues optionales Feld `args?: unknown` (zusätzlich zu vorhandenem `preview`).
- **`toolArgsSummary()`** (`src/cli/App.tsx:96`): Neue Helper-Funktion, die pro Tool-Typ eine kurze Zusammenfassung aus den Args generiert.
- **`ToolCard`-Titel** (`src/cli/App.tsx:206-209`): Titel wird jetzt als `<symbol> <name>: <summary>` gerendert (wenn Summary vorhanden), sonst `<symbol> <name>`.
- **`tool_call_start`-Handler** (`src/cli/App.tsx:883`): Speichert `event.args` auf dem ToolItem und setzt `preview` auf die generierte Summary.

## Per-Tool Summary-Format

| Tool | Format | Beispiel |
|------|--------|----------|
| `exec` | `$ <command>` | `$ npm test` |
| `readFile` | `<path>` optional `(L<start>-<end>)` / `(L<start>+)` | `src/main.ts (L10-50)` |
| `write` | `<path>` | `src/foo.ts` |
| `edit` | `<path> (N edits)` | `src/bar.ts (3 edits)` |
| `search_memory` | `"<query>"` | `"ambient hints"` |
| `process` | `<action> [sessionId]` | `list bg_a1b2c3` |
| *default* | *(leer — Titel zeigt nur Tool-Namen)* | — |

## Truncation

Titel wird bei `innerWidth - 4` Zeichen abgeschnitten (`...`-Suffix). `innerWidth` = `stdout.columns - 4`.

## Was NICHT geändert wurde

- `preview`-Feld bleibt erhalten, wird aber aktuell durch den Titel ersetzt (nicht separat gerendert).
- Keine Änderung an Expanded-Content (Tool-Result oder Preview bleibt unverändert).
- Keine Änderung am `tool_call_done`/`tool_call_error`-Event-Handling.

## Dokumentation

Aktualisiert: `docs/architecture/cli.md` (neuer Abschnitt "ToolCard-Rendering", ToolCard-Zeile in Komponenten-Tabelle).
