# feat/prompts-folder — Prompts aus TypeScript in Markdown-Dateien auslagern

## Motivation

Bisher war die Steer-Annotation (die Warnmeldung für Mailbox-Steering während Tool-Calls) als Template-Literal direkt in `src/core/agent.ts` hartcodiert. Mit diesem Change wird das "Files-as-API"-Pattern (siehe ADR *Files as API – Generic Tools statt Domain-Tools*) auf Prompts ausgeweitet: jeder Prompt lebt als eigenständige Markdown-Datei im Repo-Root und wird zur Laufzeit geladen + minimal getemplated. Das ist der Vorlauf für Phase-2-Context-Management (z. B. Compaction-Prompts).

## Was migriert wurde

- **`prompts/steer-annotation.md`** — Enthält den bisher in `formatSteerMessage()` hartcodierten String. Variablen: `userInput`, `timestamp`.
- **`src/prompts.ts`** — Mini-Helper (`prompt(name, vars)`) zum Laden und Substituieren. Kein Cache, keine Klasse, kein Template-Engine.
- **`src/core/agent.ts`** — `formatSteerMessage()` entfernt, stattdessen Aufruf von `prompt("steer-annotation", { userInput, timestamp })` in `drainMailbox()`.

## Was bewusst NICHT migriert wurde

- `DEFAULT_SYSTEM_PROMPT` in `src/core/agent.ts` — kommt mit Phase 2 (System-Prompt-Layer).
- Tool-Descriptions — leben an den Tool-Definitionen, keine Prompts.
- Compaction-Prompts — werden erst mit Phase 2 Context Management angelegt.

## Struktur

```
prompts/
├── README.md               # Konventionen (Files-as-API, {{varName}}, HTML-Kommentar für Doku)
└── steer-annotation.md     <!-- vars: userInput, timestamp -->
                            ⚠ Steer während Tool-Call. Behandle als Korrektur/Ergänzung …
                            {{userInput}}

src/prompts.ts              export function prompt(name, vars): string
```

**Surface:**
- `prompt(name, vars)` lädt `<name>.md` aus `prompts/`.
- Ersetzt `{{key}}` durch `vars[key]`.
- Wirft bei fehlender Variable (harter Crash → keine leise Broken-Prompts).
- Filtert einen führenden HTML-Kommentar (`<!-- … -->`) heraus, damit Doku nicht im LLM-Input landet.
- Pfad-Auflösung funktioniert in `src/` (Vitest) und `dist/` (Build) gleichermaßen.

## Tests

Neu:
- `tests/prompts.test.ts` (4 Tests):
  1. Lädt Prompt + ersetzt Variablen.
  2. Fehlende Variable → wirft mit klarem Fehler.
  3. Fehlende Datei → wirft.
  4. Snapshot-Test auf `steer-annotation` mit `userInput: "Apfelsaft"`.

Unverändert:
- `tests/agent.test.ts` — alle 30 Tests grün (inkl. Mailbox-Steering-Tests).
- Alle anderen Testdateien — grün (219 Tests gesamt).

## Packaging

- `npm run build` läuft durch (`tsc`).
- `dist/prompts.js` wird erzeugt; `PROMPTS_DIR` resolved via `import.meta.url` zu `../prompts`, also Repo-Root.
- `package.json` hat **kein** `files`-Feld; `prompts/` liegt im Repo-Root und wird daher automatisch mitveröffentlicht. Keine Änderung nötig.

## Restrisiko / Follow-ups

1. **User-Override** aus `~/.harness/prompts/` — **bewusst nicht gebaut.** System-Prompts sind Architektur und bleiben code-relativ. Kein Home-Override.
2. **Frontmatter-Schema** — falls Prompts komplexer werden (Metadaten, Versionierung).
3. **Weitere Prompt-Kandidaten** zur Auslagerung: `DEFAULT_SYSTEM_PROMPT`, ggf. Tool-Error-Templates.
4. **Trailing-Newline-Handling** — aktuell wird der Datei-Inhalt 1:1 übernommen; bei Bedarf könnte man `.trimEnd()` ergänzen.
