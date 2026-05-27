# Tool: write (write_file)

**Status:** Implementiert (MVP)
**Datei:** `src/tools/write_file.ts`
**Spec:** `AGENTS.md` → Task: Implementiere write und edit

## Überblick

Schreibt Inhalt in eine Datei. Atomares Write via `tmp + rename`. Sensitive Paths werden proaktiv geblockt.

## Parameter

| Parameter | Typ | Pflicht | Beschreibung |
|-----------|-----|---------|--------------|
| `path` | `string` | Ja | Absoluter oder relativer Pfad. `~` wird auf `$HOME` expandiert. |
| `content` | `string` | Ja | Dateiinhalt. Encoding: UTF-8. |

## Verhalten

### Tilde-Expansion

`~` oder `~/` → `$HOME` via `path_util.expandTilde()`. Danach `path.resolve(expanded)` (resolved implizit gegen `process.cwd()`).

### Sensitive-Path-Guard

Vor dem Write werden absolute Pfade gegen `WRITE_NO_FLY_PATTERNS` geprüft:

```typescript
export const WRITE_NO_FLY_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^\/etc\//, reason: "Writing to /etc/ is blocked" },
  { pattern: /^\/boot\//, reason: "Writing to /boot/ is blocked" },
  { pattern: /^\/usr\/lib\/systemd\//, reason: "Writing to /usr/lib/systemd/ is blocked" },
  { pattern: /^\/proc\//, reason: "Writing to /proc/ is blocked" },
  { pattern: /^\/sys\//, reason: "Writing to /sys/ is blocked" },
  { pattern: /^\/dev\/(?!null$|stdout$)/, reason: "Writing to /dev/ is blocked (except /dev/null and /dev/stdout)" },
  { pattern: /docker\.sock$/, reason: "Writing to docker.sock is blocked" },
];
```

**Ausnahme:** `/dev/null` und `/dev/stdout` sind erlaubt (nötig für Testing).

### Atomares Write

1. Schreibt nach `<path>.harness.tmp`
2. `fs.rename(tmp, target)` auf Zielpfad
3. Bei Fehler: tmp-Datei löschen, dann Error zurückgeben

### Mark-as-Read

Nach erfolgreichem Write: `fileState.markRead(absolutePath)` — damit direkt folgendes `edit` nicht an READ_REQUIRED scheitert.

## Error-Cases

| Input | Output |
|-------|--------|
| SENSITIVE_PATH | `SENSITIVE_PATH: Writing to /etc/ is blocked` |
| WRITE_FAILED | `WRITE_FAILED: <Original-Fehler>` |

## Output

Bei Erfolg: `ok`

## Nicht enthalten (MVP)

- Mode-Flag (create, append)
- Backups
- Cross-Agent-Locking
- Staleness-/mtime-Checks
- Diff-Return

## Abhängigkeiten

| Modul | Zweck |
|-------|-------|
| `path_util.ts` | `expandTilde()` |
| `atomic_write.ts` | tmp-Write + rename + cleanup |
| `file_state.ts` | `markRead()` |

## Beispiel

```typescript
await writeTool.execute({
  path: "config.json",
  content: '{"key": "value"}',
});
// → "ok"
```

## Fixtures (Tests)

| Fixture | Pfad | Zweck |
|--------|------|-------|
| `write_test/` | `tests/fixtures/write_test/` | Temp-Ordner für Write-Tests |
| `edit_test/` | `tests/fixtures/edit_test/` | Temp-Ordner für Edit-Tests |