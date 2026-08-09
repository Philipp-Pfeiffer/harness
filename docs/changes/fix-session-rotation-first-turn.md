# fix: erste Nachricht nach 8h-Session-Rotation sofort verarbeiten

## Problem

Nach >8h Inaktivität wurde die erste neue Nachricht nicht sofort bearbeitet.
Der Nutzer sah nur die Reset-Notice (`[Neue Session gestartet — vorheriger
Kontext wurde zurückgesetzt.]`), sein Auftrag fiel in den normalen
1s-Debounce-Pfad und wurde erst durch Nachhaken sichtbar bearbeitet. Der
Inhalt ging nicht verloren, aber die UX war "verschluckt".

## Root cause

Zwei Rotations-Pfade endeten beide im Debounce:

1. **Live-Rotation** (`handleNormalMode` in `inbound.ts`): Nach >8h Inaktivität
   wird `rotateSessionForInactivity` aufgerufen; die auslösende Nachricht ging
   danach regulär in den Debounce-Timer.
2. **Resolution-Rotation** (`resolveWhatsAppSessionInner` in `runtime.ts`):
   Nach Daemon-Restart wird beim ersten Kontakt die alte (>8h) Session durch
   eine neue ersetzt; auch hier debouncte die erste Nachricht.

## Fix

- `resolveWhatsAppSession`/`resolveWhatsAppSessionInner` liefern jetzt
  `{ sessionId, rotated: boolean }` zurück. `rotated=true` genau dann, wenn
  eine >8h alte Session durch eine neue ersetzt wurde.
- `inbound.ts` `handleNormalMode`: Bei `rotated=true` wird die aktuelle
  Nachricht **nicht** debounct, sondern sofort als erster Turn der neuen
  Session submittet (fire-and-forget wie der Debounce-Pfad, inkl.
  Provenance-Prefix). Die Reset-Notice geht unverändert vorher im
  Rotations-Callback raus.
- Guard `!state.turnRunning`: Falls während eines laufenden Turns eine
  Rotation ansteht, greift weiterhin der bestehende Abort-and-Restart-/Steer-Pfad.
- Slash-Commands bleiben unverändert sofort auf dem Command-Pfad (kein Debounce,
  kein Provenance-Prefix) — auch nach Rotation.

## Files

- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/src/whatsapp/inbound.ts`
- `packages/agent/src/whatsapp/plugin.ts`
- `packages/agent/tests/whatsapp/inbound.test.ts`
- `packages/agent/tests/daemon/modelRef.test.ts`

## Tests

Neu/angepasst in `inbound.test.ts`:
- Rotation (>8h) → sofortiger Turn mit Originaltext + Provenance-Prefix,
  kein Debounce-Timer (Reihenfolge: Notice → Turn, da Notice im
  Rotations-Callback awaited wird).
- Resolution-Rotation (`resolveSession` liefert `rotated: true`) → sofortiger Turn.
- Keine Rotation → Debounce wie bisher (2 Nachrichten kombiniert).
- Rotation + Slash-Command → Command-Pfad, kein Turn.

Neu in `modelRef.test.ts` (Daemon-Ebene):
- `resolveWhatsAppSession` nach simuliertem Restart: `rotated=true` +
  Reset-Notice bei >8h alter Session; `rotated=false` bei aktueller Session.

```bash
CI=true pnpm --filter @harness/agent test
```
