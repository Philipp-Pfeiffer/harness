# Tool: edit (edit_file)

**Status:** Implementiert (MVP)
**Datei:** `src/tools/edit_file.ts`
**Spec:** `AGENTS.md` → Task: Implementiere write und edit

## Überblick

Editiert eine Datei durch sequenzielle Find-and-Replace-Operationen. File muss vorher gelesen worden sein (`readFile` Tool oder `write` Tool).

## Parameter

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `path` | `string` | Ja | Absoluter oder relativer Pfad. `~` wird auf `$HOME` expandiert. |
| `edits` | `Array<{oldText, newText, replaceAll?}>` | Ja | Sequenzielle Edits |

### Edit-Object

| Feld | Typ | Pflicht | Beschreibung |
|------|------|---------|--------------|
| `oldText` | `string` | Ja | Text der gefunden werden soll |
| `newText` | `string` | Ja | Replacement |
| `replaceAll` | `boolean` | Nein | `true`: alle Vorkommen ersetzen. `false` (default): exakt 1 Match nötig |

## Verhalten

### Tilde-Expansion

`~` oder `~/` → `$HOME` via `path_util.expandTilde()`. Danach `path.resolve(cwd(), expanded)`.

### Sensitive-Path-Guard

Gleiche Liste wie `write` Tool (`WRITE_NO_FLY_PATTERNS`). Liest den Export aus `write_file.ts`.

### Read-Required

Vor dem Edit: `fileState.wasRead(absolutePath)` muss `true` sein. Sonst:

```
READ_REQUIRED: file must be read before editing
```

### Edit-Sequenz

Edits werden sequenziell angewendet. Jeder Edit arbeitet auf dem Output des vorherigen.

**Pro Edit:**
1. Wenn `oldText === newText` → `NOOP_EDIT`
2. Match-Count im aktuellen Working-Content
3. Wenn `replaceAll === true`: alle ersetzen
4. Wenn `replaceAll !== true` und `matchCount !== 1` → `NOT_UNIQUE`

### Atomares Write

Finaler Inhalt wird via `atomic_write.ts` zurückgeschrieben.

## Error-Codes

| Code | Auslöser | Output-Format |
|------|----------|---------------|
| `SENSITIVE_PATH` | Path auf No-Fly-Liste | `SENSITIVE_PATH: Writing to <path> is blocked` |
| `READ_REQUIRED` | Datei nicht vorher gelesen | `READ_REQUIRED: file must be read before editing` |
| `EMPTY_EDITS` | `edits` Array leer | `EMPTY_EDITS: at least one edit is required` |
| `NOOP_EDIT` | `oldText === newText` | `NOOP_EDIT: edit <index> has identical oldText and newText` |
| `NOT_UNIQUE` | matchCount ≠ 1 (ohne replaceAll) | `NOT_UNIQUE: edit <index> found <count> matches (expected exactly 1)` |
| `WRITE_FAILED` | tmp-Write oder rename fehlgeschlagen | `WRITE_FAILED: <Original-Fehler>` |
| `READ_FAILED` | Datei konnte nicht gelesen werden | `READ_FAILED: <Original-Fehler>` |

## Output

Bei Erfolg: `ok: <anzahl der angewandten edits>`

**Beispiel:** `ok: 3`

## Nicht enthalten (MVP)

- V4A-Patch-Format
- Diff-Return
- Merge-Logik für nah beieinander liegende Edits
- Cross-Agent-Locking
- mtime/Staleness-Checks

## Abhängigkeiten

| Modul | Zweck |
|-------|-------|
| `path_util.ts` | `expandTilde()` |
| `atomic_write.ts` | tmp-Write + rename + cleanup |
| `file_state.ts` | `wasRead()`, `markRead()` |
| `write_file.ts` | `WRITE_NO_FLY_PATTERNS`, `isSensitivePath()` |