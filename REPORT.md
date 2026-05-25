# Report: Fix CLI Queue/Steer Enter (Ticket B)

## Root Cause

`PromptInput` hat bei `key.return` den `onSubmit`-Callback nur aufgerufen, wenn `!isRunning`. Der `handleSubmit` in `App` enthält aber die vollständige Logik für beide Modi: wenn `isRunningRef.current` true ist, wird die Nachricht in `mailboxRef` gepusht und als Steer angezeigt; wenn false, startet ein neuer Turn. Durch das `!isRunning`-Guard im `PromptInput` wurde Enter während eines laufenden Turns komplett verschluckt — die Nachricht landete weder in der Mailbox noch im UI.

## Geänderte Dateien

- `src/cli/App.tsx` — Entfernung des `!isRunning`-Guards im Enter-Handler von `PromptInput` (Zeile 435-443). Enter wird jetzt immer an `onSubmit` gereicht; Input wird in beiden Fällen geleert.
- `tests/cli/App.test.tsx` —
  - Umbenennung: `"blocks Enter during streaming"` → `"queues steer message during streaming"`, Erwartungen angepasst (Input leer, Steer sichtbar).
  - Neuer Test: `"queues multiple steer messages during a turn"` (Smoke-Test: 2 Messages queued → beide als Steer sichtbar, Turn schließt normal ab).

## Neue Tests

| Test | Zweck |
|------|-------|
| `queues steer message during streaming` | Verifiziert, dass Enter im laufenden Turn eine Steer-Message auslöst, den Input leert und keinen neuen `agent.run` startet. |
| `queues multiple steer messages during a turn` | Smoke-Test: während eines Turns werden zwei Messages gequeued; beide erscheinen als Steer, der Turn läuft normal zu Ende. |

## Reproduktion / Verifikation

1. Vor dem Fix: `pnpm vitest run tests/cli/App.test.tsx` — der alte Test `"blocks Enter during streaming"` prüfte absichtlich das fehlerhafte Verhalten (Text blieb im Input).
2. Fix angewendet: Enter-Guard entfernt.
3. Test aktualisiert und neuer Smoke-Test hinzugefügt.
4. **Ergebnis:** Alle 57 CLI-Tests grün (`pnpm vitest run tests/cli/`).

## Risiken / Follow-ups

- **Doku-Abweichung:** `docs/architecture/cli.md` (Keybinds-Tabelle, Zeile 483–484) beschreibt noch das alte Verhalten (`Enter` während `isRunning` = blockiert). Die Datei darf laut Constraint nicht editiert werden (nur Hinzufügungen erlaubt) — muss separat aktualisiert werden.
- **Keine Regressionen:** Der normale Send-Pfad außerhalb des Queue-Modus ist unverändert — `handleSubmit` entscheidet selbst über Queue vs. neuer Turn.
- **ADR-Konflikt:** Kein ADR betroffen; der Mailbox/Steer-Mechanismus in `docs/architecture/cli.md` (Abschnitt 7) beschreibt den korrekten Soll-Zustand.

## Touched Areas

- `src/cli/App.tsx` — `PromptInput`-Komponente, Enter-Handler
- `tests/cli/App.test.tsx` — Enter-Handler-Tests im "Persistent input and status bar"-Block
- Keine Änderungen an `src/core/agent.ts`, `src/core/mailbox.ts` oder anderen Core-Dateien
