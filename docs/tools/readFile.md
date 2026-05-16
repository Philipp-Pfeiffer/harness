# Tool: readFile

**Status:** Implementiert (MVP)
**Datei:** `src/tools/readFile.ts`
**Spec:** `AGENTS.md` → Tool: readFile (MVP)

## Überblick

Liest Dateien von der Festplatte. Unterstützt Plain-Text (UTF-8) und PDF-Extraktion.

## Parameter

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `path` | `string` | Ja | Absoluter oder relativer Pfad. `~` wird auf `$HOME` expandiert. |
| `lineStart` | `integer` | Nein | 1-indexierte Startzeile (inklusive). |
| `lineEnd` | `integer` | Nein | 1-indexierte Endzeile (inklusive). |

## Formate

### Plain Text

- **Ohne Range:** Rohe Dateiinhalte
- **Mit Range:** `--- Lines X-Y of Z ---\n<content>`

### PDF

Erkennung via Magic-Bytes (`%PDF-`). Text-Extraktion via `pdfjs-dist/legacy`.

- **Output:** `--- PDF, N pages ---\n<extrahierter Text>`

## Error-Cases

| Input | Output |
|-------|--------|
| Datei nicht gefunden | `File not found: <resolvedPath>` |
| Kein Zugriff | `Permission denied: <resolvedPath>` |
| Pfad ist Directory | `Path is a directory, not a file: <resolvedPath>` |
| Binary (Null-Byte) | `Unsupported binary format (null byte detected). Only UTF-8 text and PDF are supported.` |
| Text >64KB ohne Range | `Extracted text exceeds 64 KB (X bytes). Use lineStart/lineEnd to read a range.` |
| PDF-Parsing fehlgeschlagen | `Failed to parse PDF: <error>` |
| `lineStart > lineEnd` | `Error: lineStart must be <= lineEnd` |
| `lineStart` > Zeilenanzahl | `Error: lineStart out of range (file has X lines)` |
| `lineEnd` > Zeilenanzahl | Silent clamp auf letzte Zeile (kein Error) |

## Größenlimit

- **64 KB** auf den extrahierten Text (nach UTF-8-Read bzw. PDF-Extraktion).
- Bei Überschreitung ohne `lineStart`/`lineEnd` → Error.
- Mit Range: Limit wird nach Slice nochmal geprüft.

## Path-Resolution

1. `~` oder `~/` → `$HOME`
2. `path.resolve(cwd(), expanded)`
3. **Keine Path-Restrictions** — absolute Pfade, `..`, alles erlaubt.

## Fixtures (Tests)

| Fixture | Pfad | Zweck |
|---------|------|-------|
| `sample.txt` | `tests/fixtures/sample.txt` | UTF-8 Text, 5 Zeilen |
| `large.txt` | `tests/fixtures/large.txt` | >64KB Text für Size-Limit-Tests |
| `binary.bin` | `tests/fixtures/binary.bin` | Null-Byte für Binary-Detection |
| `sample.pdf` | `tests/fixtures/sample.pdf` | Minimal-PDF für PDF-Tests |

## Nicht enthalten (MVP)

- Path-Scoping / Workspace-Root Isolation
- Logger-Integration
- Binary-Decode (nur Error bei Null-Byte)
- Weitere Formate (Word, HTML, etc.)