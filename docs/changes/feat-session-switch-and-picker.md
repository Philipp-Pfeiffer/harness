# Change: Session-Layout-Fix + `/session` Command + interaktiver Picker

## Übersicht

Dieser Change ergänzt Harness mit einem laufzeit-fähigen Session-Resume-Mechanismus und einem interaktiven Session-Picker in der TUI.

Er besteht aus zwei aufeinander aufbauenden Teilen:

1. **Session-Storage-Layout-Fix** (`feat/session-switch`)
2. **Interaktiver `/session`-Picker** (`feat/session-picker`)

## Motivation

Bisher lagen Session-Transcripts flach unter `~/.harness/sessions/{id}.jsonl`. Das skaliert schlecht, und ein Wechsel zurück in eine frühere Session war nur durch manuelles Auffinden der ID möglich. Mit diesem Change:

- liegen neue Transcripts im datierten Ordner-Layout `~/.harness/sessions/YYYY-MM-DD/{id}.jsonl`,
- können ältere Sessions mit `/session` interaktiv ausgewählt und resumed werden,
- wird vor dem Laden großer Histories (≥50k geschätzte Tokens) explizit gewarnt.

## Teil 1 — Session-Layout-Fix

### Neues Pfad-Layout

Neue Transcripts werden nach Erstellungsdatum in Tagesordner geschrieben:

```
~/.harness/sessions/
├── sessions.json
└── 2026-06-25/
    └── 20260625T174426-abc123.jsonl
```

Das Datum wird aus der Session-ID (`YYYYMMDDTHHMMSS-…`) abgeleitet.

### Legacy-Kompatibilität

- `readSession()` und `loadSession()` probieren zuerst den datierten Pfad, dann den flachen Legacy-Pfad und scannen abschließend alle Tagesordner.
- `migrateLegacySessionFiles()` verschiebt flache `.jsonl`-Dateien einmalig in den passenden `YYYY-MM-DD`-Ordner.

### Token-Schätzung

`estimateContextTokens()` gibt eine grobe Schätzung der zu ladenden Message-History zurück:

- ~4 Zeichen pro Token
- kleiner Overhead pro Message

Diese Schätzung dient ausschließlich der Warn-Entscheidung, nicht der Abrechnung.

### Neue/erweiterte Core-API

| Funktion | Zweck |
|----------|-------|
| `createSession()` | Schreibt Transcript in `YYYY-MM-DD/{id}.jsonl` |
| `readSession()` | Liest aus datiertem oder Legacy-Pfad |
| `loadSession()` | Lädt Session + Turns + Token-Schätzung für Resume |
| `listSessionsWithDetails()` | Liefert Index + `turnCount` + `tokenEstimate` |
| `migrateLegacySessionFiles()` | Optionale einmalige Migration alter flacher Dateien |
| `turnsToMessages()` | Rekonstruiert LLM-History aus persisted turns |
| `estimateContextTokens()` | Schätzt Context-Tokens der History |

### Konstanten

- `SESSION_LOAD_WARN_THRESHOLD = 50_000`
- `SESSION_LOAD_SILENT_MAX = 30_000`

## Teil 2 — `/session` Command + interaktiver Picker

### Slash-Commands

| Command | Verhalten |
|---------|-----------|
| `/session` | Öffnet den interaktiven Session-Picker |
| `/session <id>` | Resumed die angegebene Session direkt |
| `/session <id> --force` | Umgeht die Token-Warnung |

### Picker-Verhalten

- Gleiches UI-Pattern wie der Model-Switcher (`Box` mit `Text`-Zeilen, ↑/↓/Enter/Esc).
- Zeilen sortiert nach `lastActivity` absteigend.
- Pro Zeile: `id · Datum · Model · #Turns · tokenTotal`.
- Aktuelle Session ist mit `●` markiert.
- Live-Filter beim Tippen (id, Titel, Model).
- Auswahl triggert denselben Flow wie `/session <id>`.

### Threshold-Warnung

Wenn die geschätzte Context-History der ausgewählten Session ≥ `SESSION_LOAD_WARN_THRESHOLD` ist:

- Picker schließt.
- Eine Warnung mit Token-Zahl und Threshold wird als Completed-Turn gerendert.
- Der User muss `y` + Enter eingeben, um fortzufahren; alles andere bricht ab.
- `--force` umgeht die Warnung.

### Resume-Flow

1. Laufende Session wird mit `endSession()` finalisiert.
2. Ziel-Session wird mit `loadSession()` geladen.
3. `historyRef.current` wird auf `turnsToMessages(turns)` gesetzt.
4. Alte Turns werden als `CompletedTurn`s in den Scrollback gerendert.
5. `sessionRef.current`, `metricsRecorder` und ggf. das aktive Model werden umgestellt.
6. Folge-Turns werden an dieselbe Session angehängt (echtes Resume, kein Fork).

## Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `src/core/session.ts` | Datiertes Layout, Legacy-Read, Migration, Token-Schätzung, `loadSession`, `listSessionsWithDetails` |
| `src/cli/commands.ts` | `/session` zur Autocomplete-Liste hinzugefügt |
| `src/cli/sessionCommand.ts` | **Neu** — Parser/Formatter für `/session` und Warn-Text |
| `src/cli/App.tsx` | `/session`-Handler, Picker-UI, Resume-Flow, Threshold-Bestätigung |
| `tests/core/session.test.ts` | **Neu/Erweitert** — Layout, Legacy, Migration, Threshold-Tests |
| `tests/cli/App.test.tsx` | Picker-, Resume-, Threshold- und Append-Tests |

## Tests

- Datierte Ordner-Auflösung
- Lesen flacher Legacy-Transcripts
- `migrateLegacySessionFiles()`
- Token-Schätzung unter 30k / über 50k
- `loadSession()` mit Schätzung
- `/session` öffnet Picker
- ↑/↓ + Enter wählt Session
- Esc bricht Picker ab
- Tipp-Filter schränkt Liste ein
- Picker-Auswahl ≥50k zeigt Warnung und fordert Bestätigung
- `/session <id>` resumed und appended neue Turns an dieselbe Session

## Validation

- `pnpm typecheck` grün.
- `npx vitest run`: 417 passed, 2 unabhängige/vorher bestehende Failures (`prompts.test.ts` Snapshot, `non-tty.test.ts` Dotenv-Logs).

## Non-Goals

Nicht implementiert:

- ❌ Keine vollständige Session-Browser-TUI mit Suchen/Scrollen außerhalb des Pickers
- ❌ Kein automatisches Migrieren beim Startup (Migration ist manuell/explizit)
- ❌ Kein exakter Tokenizer (nur Heuristik)
- ❌ Keine Token-Warnung für die laufende Session, nur für Resume
