# Turn-Queue Race Condition im Daemon

**Datum:** 2026-07-17  
**Typ:** Bugfix

## Problem

`DaemonRuntime.handleIpcRequest`, Case `submit-turn` (`packages/agent/src/daemon/runtime.ts`): Das `turnPromise` wurde als **sofort ausgeführte IIFE** erzeugt, *bevor* es an `entry.turnQueue` gekettet wurde:

```ts
const turnPromise = (async () => { await agent.run(messages, …); … })();
entry.turnQueue = entry.turnQueue.then(() => turnPromise, () => turnPromise);
```

Die Kettung serialisierte nur das *Awaiten* des bereits laufenden Promises — der Turn-Body (`agent.run` auf dem geteilten `entry.messages`) startete sofort. Zwei parallele `submit-turn`s auf derselben Session liefen damit **konkurrent** auf `entry.messages`: Interleaves im Kontext, doppelte `recordTurn`-Writes, korrupte Turn-Reihenfolge.

Zusätzlich riss ein fehlgeschlagener Turn die Queue nicht ab (das funktionierte über den zwei-arg `.then`), aber der User-Message-Push erfolgte *vor* dem Queue-Eintritt — ein queued Turn sah die User-Message des nächsten Turns bereits im Kontext.

## Befund (zweiter Race, durch den neuen Test aufgedeckt)

`saveIndex` (`packages/agent/src/core/session.ts`) schrieb den Sessions-Index über einen **festen Tmp-Pfad** (`index.json.tmp`) + `rename`. Zwei parallele `recordTurn`s auf **verschiedenen** Sessions (erst durch den Fix erlaubt bzw. sichtbar) rasten: `rename` schlug mit `ENOENT` fehl, und die nicht-serialisierte load→modify→save-Sequenz verlor still Index-Updates.

## Fix

### 1. `runtime.ts` — Producer statt IIFE

- Turn-Body ist jetzt eine **Promise-Erzeuger-Funktion** `runQueuedTurn`, die an `entry.turnQueue.then(runQueuedTurn, runQueuedTurn)` übergeben wird — der Turn startet erst, wenn der vorherige Turn der Session vollständig settled ist.
- **Catch zwischen Turns:** `entry.turnQueue = turnPromise.catch(() => undefined)` — die gespeicherte Queue-Promise bleibt nie rejected, ein fehlgeschlagener Turn reißt die Queue nicht ab.
- Der User-Message-Push und `turnStartedAt`/`turnStartedMs` wandern **in den queued Body** — `entry.messages` wird nur noch unter der Queue mutiert (strikt seriell, keine Interleaves), und die Turn-Timestamps messen die tatsächliche Laufzeit statt Queue-Wartezeit.
- Validierung (`text` oder `messages` erforderlich) bleibt vor dem Queue-Eintritt.
- Der stale Kommentarblock über Mailbox-Steering wurde durch eine akkurate Beschreibung der Queue-Semantik ersetzt (der Handler pusht nie in die Mailbox; jeder `submit-turn` queued einen Turn).

### 2. `session.ts` — Index-Writes sicher machen

- `saveIndex`: eindeutiger Tmp-Name (`…​.<pid>.<uuid>.tmp`) — zwei Harness-Prozesse auf demselben `$HARNESS_STATE` überschreiben sich nicht gegenseitig die Tmp-Datei.
- `upsertIndexEntry`: load→modify→save läuft über eine modul-globale Promise-Kette (`indexUpdateQueue`) serialisiert — keine Lost-Updates bei parallelen Sessions; `catch` hält die Kette bei Fehlern am Leben.

## Tests

Neu: `packages/agent/tests/daemon/turnQueueConcurrency.test.ts` — fährt die **echte** `DaemonRuntime` (temp `HARNESS_HOME`/`HARNESS_STATE`, injizierter Fake-Agent mit Start/End-Events + Message-Snapshots, direkter Aufruf von `handleIpcRequest`):

1. **Same-Session-Serialisierung:** Zwei parallele `submit-turn`s laufen strikt seriell in Submit-Reihenfolge (exakte Event-Sequenz assertiert); Turn 1 sieht nur seine eigene User-Message, Turn 2 sieht Turn 1 komplett + eigene Message — keine Interleaves auf `entry.messages`.
2. **Cross-Session-Parallelität:** Ein Turn auf Session B startet, während Session A noch läuft — separate Queues, kein Blocking. (Deckte den `saveIndex`-Race auf.)
3. **Queue überlebt Fehler:** Ein fehlschlagender Turn (`error`-Response) lässt den nachfolgenden queued Turn trotzdem laufen.

Verifiziert: Mit altem `runtime.ts` (IIFE) schlägt Test 1 fehl. `tsc --noEmit` clean, `vitest run` in `@harness/agent`: 23 Files / 219 Tests grün.

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/agent/src/daemon/runtime.ts` | Producer-Chaining statt IIFE, Catch in der Queue, Message-Push + Timestamps in den Turn-Body, Kommentar korrigiert |
| `packages/agent/src/core/session.ts` | Eindeutiger Tmp-Name in `saveIndex`, serialisierte `upsertIndexEntry` |
| `packages/agent/tests/daemon/turnQueueConcurrency.test.ts` | Neu — 3 Concurrency-Tests gegen die echte Runtime |
