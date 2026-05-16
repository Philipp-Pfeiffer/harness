# Tool: readFile – Erweiterung

**Status:** Erweitert
**Datei:** `src/tools/readFile.ts`
**Geändert:** `markRead()` Aufruf nach erfolgreichem Read

## Änderung

Nach jedem erfolgreichen Read wird `fileState.markRead(resolvedPath)` aufgerufen.

## Warum?

`edit` erfordert Read-Before-Edit. Wenn `readFile` die Datei liest, muss sie als "gelesen" markiert werden, damit ein direkt folgendes `edit` nicht an `READ_REQUIRED` scheitert.

## Mark-as-Read Stellen

### PDF-Pfad

```typescript
// Nach PDF-Text-Extraktion, vor dem Return
markRead(resolvedPath);
return `--- PDF, ${doc.numPages} pages ---\n${text}`;
```

### Plain-Text-Pfad (mit Range)

```typescript
// Nach Zeilen-Slice, vor dem Return
markRead(resolvedPath);
return `--- Lines ${start}-${clampedEnd} of ${totalLines} ---\n${content}`;
```

### Plain-Text-Pfad (ohne Range)

```typescript
// Nach Size-Check, vor dem Return
markRead(resolvedPath);
return content;
```

## Hinweis

Nur der erfolgreiche Pfad führt zu `markRead()`. Error-Cases (nicht gefunden, Permission denied, etc.) markieren **nicht** als gelesen — das wäre falsch, da `edit` sonst trotzdem arbeiten könnte.