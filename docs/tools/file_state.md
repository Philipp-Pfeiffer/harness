# Modul: file_state

**Status:** Implementiert (MVP)
**Datei:** `src/tools/file_state.ts`
**Spec:** `AGENTS.md` → Task: file_state.ts

## Überblick

Minimaler In-Memory-State für Read-Required bei `edit`. Ermöglicht dem `edit`-Tool zu prüfen, ob eine Datei vor einem Edit **in derselben Session** gelesen wurde.

## API

```typescript
function markRead(sessionId: string, absolutePath: string): void
function wasRead(sessionId: string, absolutePath: string): boolean
```

### markRead

Normalisiert den Pfad via `path.resolve()` und speichert ihn im internen `Set<string>` der übergebenen Session.

### wasRead

Normalisiert den Pfad via `path.resolve()` und prüft ob er im Set **derselben Session** ist.

## Storage

- **Interne Map:** `Map<sessionId, Set<string>>` — modul-level, aber pro Session isoliert
- **Kein globaler Fallback:** ohne `sessionId` zählt jede Datei als ungelesen (`READ_REQUIRED`)
- **Lebensdauer:** Process-Lifetime (keine Persistence)
- **Keine TTL, kein mtime-Tracking**

## Session-Scope

Der `sessionId`-Scope kommt aus dem `ToolCallContext`, den der Agent-Loop an `Tool.execute` übergibt (`RunOptions.sessionId` → `compaction.sessionId` → per-Agent-Default). Parallele Daemon-Sessions teilen sich dadurch **keinen** Read-State: Eine Datei, die nur Session A gelesen hat, kann von Session B nicht editiert werden.

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