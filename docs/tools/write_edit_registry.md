# Tool-Registry – write & edit

**Datum:** 2026-04-26
**Status:** Implementiert (MVP)

## Überblick

Zwei neue Tools wurden dem Harness hinzugefügt: `write` und `edit`. Sie teilen sich Infrastruktur-Module (`path_util`, `atomic_write`, `file_state`).

## Architektur

```
write_file.ts          edit_file.ts
       │                     │
       ├─ path_util.ts        ├─ path_util.ts
       ├─ atomic_write.ts    ├─ atomic_write.ts
       ├─ file_state.ts      ├─ file_state.ts
       └─ write_file.ts (isSensitivePath, WRITE_NO_FLY_PATTERNS)
```

**Keine zirkulären Abhängigkeiten:** `write_file.ts` exportiert `isSensitivePath` und `WRITE_NO_FLY_PATTERNS` — `edit_file.ts` importiert nur diese, importiert nicht `writeTool` selbst.

## Module

### path_util.ts

Geteilte Utility-Funktionen. **Extrahiert aus `bash.ts` und `readFile.ts`** (die beide duplizierten `expandTilde`-Code hatten).

```typescript
export function expandTilde(pathStr: string): string
```

### atomic_write.ts

Atomares Write für beide Tools:

```typescript
export async function atomicWrite(
  absolutePath: string,
  content: string
): Promise<{ ok: true } | { ok: false; message: string; code: string }>
```

1. Schreibt nach `<path>.harnes.tmp`
2. `fs.rename(tmp, target)`
3. Bei Fehler: tmp löschen

### file_state.ts

In-Memory Set für Read-Tracking:

```typescript
export function markRead(absolutePath: string): void
export function wasRead(absolutePath: string): boolean
```

### write_file.ts

| Export | Beschreibung |
|--------|-------------|
| `WriteArgs` | TypeBox Schema |
| `writeTool` | Tool-Objekt |
| `WRITE_NO_FLY_PATTERNS` | Sensitive-Path Patterns |
| `isSensitivePath()` | Guard-Funktion |

### edit_file.ts

| Export | Beschreibung |
|--------|-------------|
| `EditArgs` | TypeBox Schema |
| `editTool` | Tool-Objekt |

## Tool-Registry

In `src/tools/registry.ts`:
```typescript
export function loadTools(): Tool[] {
  return [echoTool, readFileTool, bashTool, writeTool, editTool];
}
```

## Sensitive-Path-Liste

Gemeinsame Liste für `write` und `edit`:

| Pattern | Reason |
|---------|--------|
| `/^\/etc\//` | Writing to /etc/ is blocked |
| `/^\/boot\//` | Writing to /boot/ is blocked |
| `/^\/usr\/lib\/systemd\//` | Writing to /usr/lib/systemd/ is blocked |
| `/^\/proc\//` | Writing to /proc/ is blocked |
| `/^\/sys\//` | Writing to /sys/ is blocked |
| `/^\/dev\/(?!null$\|stdout$)/` | Writing to /dev/ is blocked (except /dev/null and /dev/stdout) |
| `/docker\.sock$/` | Writing to docker.sock is blocked |

## Error-Shape

Alle Tools geben **einfachen String** zurück (kein `{isError, content}` Object wie `bash.ts` intern). Das ist konsistent mit dem Tool-Interface:

```typescript
execute(args: Static<TParameters>): Promise<string> | string
```

## Test-Suite

| Datei | Tests |
|-------|-------|
| `tests/tools/file_state.test.ts` | 6 Tests |
| `tests/tools/write_file.test.ts` | 13 Tests |
| `tests/tools/edit_file.test.ts` | 10 Tests |

**Alle 71 Tests passieren.**

## Nicht implementiert (bewusst)

- Mode-Flag für write (create, append)
- Backups
- Cross-Agent-Locking
- mtime/Staleness-Checks
- V4A-Patch-Format
- Diff-Return
- Merge-Logik für überlappende Edits
- `readFileTool` / `editTool` Export in `index.ts` (nur via `registry.ts` nutzbar)