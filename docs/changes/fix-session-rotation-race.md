# fix-session-rotation-race

## Problem / Symptom

**Incident 11.08. 09:02 (forensisch belegt):** Nach einer 8h-Session-Rotation wurde
die frisch erstellte Session mitten im ersten Turn beendet. Folge: Der Turn
landete in einer beendeten Session, eine neue Session startete leer, Kontextverlust.

## Root Cause

`handleNormalMode` rotiert bei >8h Inaktivität (`rotateSessionForInactivity`),
setzt danach aber `state.lastActivityMs` nicht — das Update passiert nur in
`handleTurnComplete` (inbound.ts). Läuft der erste Turn nach der Rotation länger
als der Abstand zur nächsten User-Nachricht, feuert der 8h-Check erneut
(Altwert!) und beendet die frisch erstellte Session mitten im ersten Turn.

Zwei Folgeprobleme:

1. **Guard fehlt:** Kein Schutz gegen jeden Edge-Case, in dem `lastActivityMs`
   nicht rechtzeitig aktualisiert wird (z. B. Fehlerpfade).
2. **Steer-Session-Mismatch:** Im Steering-Pfad (turnRunning-Branch) wurde in
   `state.sessionId` gesteuert. Rotiert die Session während eines laufenden
   Turns, zeigt `state.sessionId` auf die neue, leere Session — die hat aber
   keinen Turn, ein Steer dort fault erst Minuten später im falschen Kontext ein.

## Änderungen

### `packages/agent/src/whatsapp/limits.ts`

Neuer Konstante `ROTATION_GUARD_MS = 60_000` — Cooldown nach einer Rotation,
währenddessen der 8h-Inaktivitäts-Check übersprungen wird.

### `packages/agent/src/whatsapp/inbound.ts`

1. **Primär:** Nach erfolgreicher Rotation `state.lastActivityMs = Date.now()`
   setzen — direkt nach `rotateSessionForInactivity` in `handleNormalMode` UND
   im `resolveSession`-Zweig, wenn `resolved.rotated` true ist (beide Pfade, in
   denen eine frische Session entsteht). Das behebt den Incident-Datenpfad direkt.
2. **Guard:** `state.rotatedAt: number` (Default 0) im `SourceState`
   eingeführt, bei Rotation auf `Date.now()` gesetzt. Der Inaktivitäts-Check
   wird übersprungen solange `Date.now() - state.rotatedAt < ROTATION_GUARD_MS`.
   Schützt zusätzlich gegen jeden Edge-Case mit staler `lastActivityMs`.
3. **Steer-Session-Mismatch:** `state.turnSessionId: string | null` beim
   Turn-Start (`flushDebounced`) auf `state.sessionId` gesetzt, bei
   Turn-Ende (`handleTurnComplete`) auf `null` zurückgesetzt. Im
   Steering-Pfad wird in `state.turnSessionId ?? state.sessionId` gesteuert —
   also in die Session des LAUFENDEN Turns, nicht in die ggf. frisch rotierte
   `state.sessionId`.

### `packages/agent/tests/whatsapp/inbound.test.ts`

Neue Testgruppe "Session Rotation Race (incident 11.08.)":

| Test | Zweck |
|------|-------|
| `does NOT re-rotate when the first turn after rotation is still running...` | Simuliert den Incident exakt: Inbound → Rotation → Turn läuft (mock) → zweiter Inbound im Fenster → KEINE zweite Rotation, zweite Nachricht als Steer beim laufenden Turn der richtigen Session, `lastActivityMs` ist nach Rotation aktuell. |
| `skips the 8h-inactivity check within the rotation guard window...` | Guard-Test: künstlich alte `lastActivityMs` + frisches `rotatedAt` → keine Rotation. |
| `allows the 8h check again after the rotation guard window expires` | Guard läuft nach 60s ab → 8h-Check wieder aktiv. |
| `updates lastActivityMs when the rotation happens via resolveSession...` | Fallback-Test: `resolveSession`-Rotation aktualisiert `lastActivityMs` und setzt `rotatedAt`; Folge-Inbound im selben Tick rotiert nicht. |
| `steers into the running turn's session when a rotation happened mid-turn` | Steer-Mismatch: laufender Turn (Tool ausgeführt) + Rotation währenddessen → Steer geht in `turnSessionId`, nicht in die frische Session. |

## Dateien

- `packages/agent/src/whatsapp/limits.ts`
- `packages/agent/src/whatsapp/inbound.ts`
- `packages/agent/tests/whatsapp/inbound.test.ts`

## Tests

- `pnpm build` — grün
- `pnpm typecheck` — grün (nach `pnpm --filter @harness/core build`)
- `pnpm --filter @harness/agent test` — 48 Files / 526 Tests grün
- `pnpm --filter @harness/core test` — 548/549 grün; einziger Failure ist der
  pre-existing Flake `exec.test.ts` (sudo / passwordless, "Ein Passwort ist
  notwendig"). `non-tty.test.ts` (Agent-Paket) ist grün.

## Hinweis

Parallel läuft `fix/turn-abort-control`, der in derselben Funktion
(`handleNormalMode` in `packages/agent/src/whatsapp/inbound.ts`) den
abort-and-restart-Block entfernt und den Steering-Pfad vereinfacht. Der Diff
dieses Changesets ist bewusst chirurgisch gehalten: `turnSessionId` wird im
Steering-Pfad (Ziel-Session) und am Turn-Start/-Ende gesetzt, kollidiert aber
nicht mit der Steer-/Stop-Logik des Parallel-Branches — ein Rebase sollte
trivial bleiben.

## Merge (2026-08-11)

Gemergt mit `fix/turn-abort-control` in Branch `fix/turn-control-plus-rotation`.
Eine Konfliktdatei (`inbound.ts`), fünf Konfliktstellen, alle in `handleNormalMode`
bzw. `SourceState`:

- **SourceState:** `turnSessionId` und `rotatedAt` (rotation-race) übernommen; die
  von turn-control entfernten Felder (`restartCount`, `hasToolExecuted`, `turnStartMs`,
  `currentTurnText`, `currentTurnImageBlocks`, `currentTurnAnnotations`) bleiben entfernt.
- **State-Init:** `const now`-Pattern + `turnSessionId: null`, `rotatedAt: resolved.rotated ? now : 0`.
- **Steer-Pfad:** `steerSessionId = state.turnSessionId ?? state.sessionId` (rotation-race-Ziel),
  vereinfachter Log-Eintrag ohne `toolExecuted`/`restarts` (turn-control entfernt die).
- **flushDebounced:** Nur `state.turnSessionId = state.sessionId` übernommen; abort-and-restart-Felder
  von rotation-race verworfen (turn-control braucht sie nicht mehr).
- **handleTurnComplete:** `state.turnSessionId = null` + `state.lastActivityMs = Date.now()`
  (beide Branches haben das, aber turnSessionId-Reset nur von rotation-race).

Tests: Beide Testgruppen (Stop-Wort/Steer-always von turn-control + Session Rotation Race
von rotation-race) gemeinsam grün. Zwei rotation-race-Tests mussten angepasst werden:
`setToolExecuted` existiert nicht mehr (Steer-always macht es überflüssig), und die
Erwartung im resolveSession-Test (Steer statt zweitem submitTurn) reflektiert jetzt
das Steer-always-Verhalten des gemergten Codes.
