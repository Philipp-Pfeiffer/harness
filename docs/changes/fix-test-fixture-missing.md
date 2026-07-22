# Fix: Fehlende Test-Fixtures ergänzt

## Problem
17 Test-Failures in 3 Test-Files (readFile, exec, edit_file), weil Tests-Fixtures
in `tests/fixtures/` nie committed wurden. Bei frischem Clone fehlten:
- `sample.txt` — UTF-8-Textdatei für readFile/readLine-Tests
- `large.txt` — >64KB-Datei für Size-Limit-Tests
- `binary.bin`, `binary-late-null.bin`, `binary-png-magic.bin`, `binary-zip-magic.bin` — Binärdateien für Binary-Detection-Tests
- `sample.pdf` — Minimal-PDF für PDF-Extraktions-Tests
- `file1.txt`, `file2.txt`, `file3.txt` — Dateien für exec-Glob-Test

## Befund
Fixtures waren lokal vorhanden (von vorherigen Testläufen), aber nie ins Git
eingetragen. `tests/fixtures/` im `.gitignore` nicht erwähnt — schlicht vergessen.

## Änderung
- `tests/fixtures/` mit allen benötigten Fixtures ergänzt.
- `sample.txt`: 4 Zeilen, kein Trailing-Newline → `split("\n")` ergibt exakt 4 Elemente.
  Warte — tatsächlich 4 Zeilen mit Trailing-Newline → `split("\n")` ergibt 5 mit leerem
  letzten Element. Inhalt: `Hello...`, `Line 3 here.`, `Line 4 there.`, `Line 5 here.`
- `large.txt`: 7000 Zeilen, ~68KB → triggert 64KB-Limit.
- `binary.bin`: Null-Byte near start.
- `binary-late-null.bin`: Null-Byte nach Position 1024.
- `binary-png-magic.bin`: PNG-Magic-Header (`\x89PNG\r\n\x1a\n`).
- `binary-zip-magic.bin`: ZIP-Magic-Header (`PK\x03\x04`).
- `sample.pdf`: Minimal valides 1-Page-PDF mit Text "Hello PDF".
- `file1.txt`–`file3.txt`: Textdateien für exec-Glob-Test.

## Dateien
- `tests/fixtures/sample.txt` (neu)
- `tests/fixtures/large.txt` (neu)
- `tests/fixtures/binary.bin` (neu)
- `tests/fixtures/binary-late-null.bin` (neu)
- `tests/fixtures/binary-png-magic.bin` (neu)
- `tests/fixtures/binary-zip-magic.bin` (neu)
- `tests/fixtures/sample.pdf` (neu)
- `tests/fixtures/file1.txt` (neu)
- `tests/fixtures/file2.txt` (neu)
- `tests/fixtures/file3.txt` (neu)

## Tests
- `npx vitest run` → 669/669 passed, 56/56 test files passed
