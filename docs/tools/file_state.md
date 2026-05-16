# Modul: file_state

**Status:** Implementiert (MVP)
**Datei:** `src/tools/file_state.ts`
**Spec:** `AGENTS.md` → Task: file_state.ts

## Überblick

Minimaler In-Memory-State für Read-Required bei `edit`. Ermöglicht dem `edit`-Tool zu prüfen, ob eine Datei vor einem Edit gelesen wurde.

## API

```typescript
function markRead(absolutePath: string): void
function wasRead(absolutePath: string): boolean
```

### markRead

Normalisiert den Pfad via `path.resolve()` und speichert ihn im internen `Set<string>`.

### wasRead

Normalisiert den Pfad via `path.resolve()` und prüft ob er im Set ist.

## Storage

- **Internes Set:** `new Set<string>()` — modul-level
- **Lebensdauer:** Process-Lifetime (keine Persistence)
- **Keine TTL, kein mtime-Tracking**

## Path-Normalisierung

`path.resolve()` wird vor dem Speichern/Prüfen aufgerufen. Das bedeutet:

```
~/foo          → /home/<user>/foo (für wasRead als identisch mit absolutem Pfad)
./relative     → /absolut/resolved/./relative
```

**Konsequenz:** `~/foo` und der resolved absolute Pfad zeigen auf denselben Entry im Set.

## Warum nötig?

`edit` erfordert, dass eine Datei vorher gelesen wurde. Das verhindert Blind-Edits auf Dateien, die der Agent nie gesehen hat. `write` markiert nach jedem erfolgreichen Write automatisch als gelesen.

## Nicht enthalten (MVP)

- Persistence (SQLite, JSON-File, etc.)
- mtime-basierte Invalidierung
- TTL
- Cross-Process-Sharing