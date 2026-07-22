# Session-Logging-Batch: Compaction-Slice-Bug + Index-Korruption

**Datum:** 2026-07-22
**Typ:** Bugfix

## Problem

Zwei Bugs aus `docs/audit/session-logging-audit.md`:

### 1. Latenter Compaction-Slice-Bug (`agent.ts:379-383`)

Wenn die Agent-Loop mid-turn eine Compaction durchführt, ersetzt sie das Message-Array in-place:

```ts
context.messages = compactionResult.messages;
messages.length = 0;
messages.push(...compactionResult.messages);
```

Sowohl `InProcessBackend.persistTurn` als auch `DaemonRuntime.handleIpcRequest` berechneten den Turn-Slice mit `messages.slice(messagesBeforeTurn)`, wobei `messagesBeforeTurn` ein **numerischer Index** war, der *vor* dem Compaction-Clear gepusht wurde. Nach Compaction sind die Original-Indices verschoben — `turnSlice` enthielt Teile der Compaction-Summary oder fehlende Turn-Messages, was zu inkonsistenten Session-Transkripten führte.

### 2. Index-Korruption macht alle Sessions unsichtbar (`session.ts:272-278` + `:449-451`)

`loadIndex` behandelte korruptes JSON als leeren Index (`return []`). `readSession` verlangte einen Index-Eintrag (`if (!entry) return null`) und durchsuchte Transkripte nur, wenn der Index-Eintrag existierte. Eine korrupte `sessions.json` blendete also **alle** Sessions aus, obwohl die Transkriptdateien unversehrt auf der Platte lagen.

## Fix

### 1. User-Message per Referenz tracken statt numerischem Index

Statt `messagesBeforeTurn = messages.length` wird der Referenz auf das gepushte User-Message-Objekt gespeichert. Nach dem Agent-Run (ggf. mit Compaction) wird `messages.indexOf(userMessage)` verwendet, um den korrekten Start-Index des Turn-Slices zu finden — auch wenn das Array zwischenzeitlich in-place ersetzt wurde.

**Betroffene Producer-Pfade:**
- `packages/agent/src/backends/inProcessBackend.ts` — `runTurn` + `persistTurn`
- `packages/agent/src/daemon/runtime.ts` — `submit-turn` Handler

### 2. Fallback auf Transkript-Scan bei fehlendem Index-Eintrag

`readSession` lädt jetzt immer das Transkript, wenn die Datei existiert — auch ohne Index-Eintrag. Fehlt der Index-Eintrag (z.B. bei korruptem Index), rekonstruiert die neue Funktion `reconstructIndexEntry` einen minimalen Eintrag aus den Transkript-Turns:
- `created` aus dem ersten Turn
- `lastActivity` aus dem letzten Turn
- `model` aus dem letzten Turn
- `tokenTotals` aufsummiert aus allen Turns
- `status: "idle"` (sicherer Default für Recovered Sessions)

**Datei:** `packages/agent/src/core/session.ts`

## Tests

Neu in `packages/agent/tests/core/session.test.ts`:
- `readSession > reconstructs index entry from transcript when index is corrupt` — schreibt eine korrupte `sessions.json`, verifiziert dass Sessions trotzdem über Transkripte sichtbar bleiben und Token-Totals rekonstruiert werden.

Alle 679 Tests grün, `tsc --noEmit` clean.

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/agent/src/backends/inProcessBackend.ts` | `messagesBeforeTurn` (number) → `userMessage` (ref), `persistTurn` nutzt `indexOf` |
| `packages/agent/src/daemon/runtime.ts` | Gleicher Fix: `userMessage`-Referenz statt numerischem Index |
| `packages/agent/src/core/session.ts` | `readSession` mit Transkript-Fallback + `reconstructIndexEntry` |
| `packages/agent/tests/core/session.test.ts` | Neuer Test für Index-Korruption-Recovery |
