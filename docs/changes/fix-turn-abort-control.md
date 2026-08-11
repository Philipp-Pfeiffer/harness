# Fix: Turn-Abort-Kontrolle — Steer-always statt Abort-and-Restart + Stop-Wort-Abort

**Date:** 2026-08-11
**Type:** fix
**Files:** `packages/agent/src/whatsapp/inbound.ts`, `packages/agent/src/whatsapp/limits.ts`, `packages/agent/src/whatsapp/plugin.ts`, `packages/agent/src/daemon/runtime.ts`, `packages/agent/src/daemon/types.ts`, `packages/core/src/core/agent.ts`, Tests (inbound, runtimeWhatsAppProgressive, agent)

## Problem

### Teil 1 — Doppel-Antwort durch Abort-and-Restart

`inbound.ts` hatte ein Abort-and-Restart-Fenster (`ABORT_RESTART_WINDOW_MS = 5_000`, `MAX_RESTARTS_PER_TURN = 2`): Kam eine User-Nachricht innerhalb von 5s nach Turn-Start und war noch kein Tool ausgeführt, wurde der laufende Turn abgebrochen und mit gemergtem Text neu gestartet. Seit Progressive Send schickt ein schnelles Modell die erste Antwort aber bereits an den User; der Restart produzierte dann eine zweite, redundante Antwort — live beobachtet als Doppel-Antwort und vermischte Inhalte. Zusätzlich war die `whatsappToolExecuted`-Map in `runtime.ts` nie befüllt, die Tool-Call-Bedingung also immer falsch (Restart lief faktisch immer bis zum Max-Counter).

### Teil 2 — Kein User-Abort möglich

Ein User konnte einen laufenden Turn nicht abbrechen. "stop" landete als Steer im Mailbox und der Agent entschied selbst, ob/wie er reagiert.

## Befund

- **`whatsappToolExecuted`** (`runtime.ts`) wurde nirgends `set`, nur gelesen → immer `false`.
- Die TUI hat bereits einen Stop-Mechanismus (`abortCurrentTurn` in `App.tsx`): `AbortController.abort()` → IPC-Socket-Close → Daemon bricht ab → `agent.run` gibt `{ aborted: true, reason: "signal" }` zurück. Der Agent-Loop hat dafür 5 Abort-Checkpoints.

## Lösung

### Teil 1 — Abort-and-Restart entfernt, Steer-always

Eine User-Nachricht während eines laufenden Turns wird **immer** als Steer in die Mailbox gereiht (`inbound.ts`). Kein Neustart, kein Textverlust: Der Steer-Pfad bleibt unverändert (Text inkl. Annotations vollständig). Debounce bei idle bleibt unverändert.

Entfernt:
- `ABORT_RESTART_WINDOW_MS`, `MAX_RESTARTS_PER_TURN` (`limits.ts`)
- `restartCount`, `hasToolExecuted`, `turnStartMs`, `currentTurnText`, `currentTurnImageBlocks`, `currentTurnAnnotations` im `SourceState` (`inbound.ts`)
- Abort-and-Restart-Pfad in `handleNormalMode` inkl. Logs
- `checkToolExecuted`-Callback (`inbound.ts`, `plugin.ts`)
- `checkWhatsAppToolExecuted` + `whatsappToolExecuted`-Map (`runtime.ts`)
- `internalAbortSignal`-Rückgabe aus `submitTurn` (war bereits tot — niemand nutzte den Rückgabewert)

### Teil 2 — Stop-Wort als harter Turn-Abort

Neuer Signalpfad (bewusst derselbe Mechanismus wie die TUI, kein Parallelbau):

```
inbound.ts: turnRunning → isStopWord("stop"/"stopp", case-insensitive, ganze Nachricht)
  → state.currentAbort.abort("user")          ← AbortController, Reason "user"
runtime.ts: submitWhatsAppTurn(sessionId, text, imageBlocks, signal)
  → agent.run(..., { signal })                 ← bestehende Abort-Checkpoints greifen
agent.ts: signal?.aborted → return { aborted: true, reason: abortReason(signal) }
```

Verhalten:
- Das AbortSignal wird an `agent.run` durchgereicht; die bestehenden Checkpoints im Agent-Loop greifen.
- Laufende Tool-Calls laufen zu Ende (`executeToolWithAbort` bricht das Tool **nicht** aktiv ab — das Signal wird zwar überwacht, aber das Tool-Ergebnis wird abgewartet; danach endet die Iteration).
- Kein LLM-Call mehr nach dem Signal (Checkpoint 1/2/3 decken das ab).
- `reason` unterscheidet: `abort("user")` → `reason: "user"`; alle bestehenden Pfade (TUI, IPC-Close) bleiben `reason: "signal"` unverändert.
- Der User bekommt sofort die Bestätigung **"Turn abgebrochen."** (via `sendOutbound` im Stop-Word-Pfad). `runtime.ts` verhindert die Doppel-Bestätigung: Bei `reason === "user"` gibt `submitWhatsAppTurn` eine leere `finalResponse` zurück; das Transcript enthält `[Turn abgebrochen]`.
- Bei idle (kein laufender Turn) ist "stop" eine normale Nachricht (Debounce-Pfad).
- Nicht von Slash-Command-Interception verschluckt (kein `/`-Präfix) und nicht vom Debounce (Turn läuft bereits).

## Signalfluss

```
WhatsApp-Nachricht "stop"
  → plugin.ts → inbound.ts (processInbound)
  → handleNormalMode: turnRunning && isStopWord
  → state.currentAbort.abort("user")
  → AbortSignal (wurde in flushDebounced an submitWhatsAppTurn übergeben)
  → runtime.ts submitWhatsAppTurn(..., signal) → agent.run(..., { signal })
  → agent.ts Checkpoint (Turn-Start / nach Tool-Result / vor Tool-Exec): reason "user"
  → inbound.ts sendet "Turn abgebrochen." (sofort beim Stop-Wort)
```

## Tests

`packages/agent/tests/whatsapp/inbound.test.ts`:
- **Steer-always bei laufendem Turn**: Nachricht während laufendem Turn (auch <5s, ohne Tool) → genau 1 `submitTurn`, Steer mit vollem Text inkl. Annotations; kein zweiter Turn.
- **Kein Steer nach Turn-Ende**: Nach Turn-Completion startet die nächste Nachricht einen Debounce-Turn.
- **Signal wird an submitTurn durchgereicht**: Signal existiert, wird beim Stop-Wort abgebrochen, `signal.reason === "user"`.
- **Stop-Wort-Abort**: exakt "stop" während laufendem Turn → Signal aborted, kein Steer, Bestätigung "Turn abgebrochen." gesendet.
- **Case-insensitive**: "STOP", "Stopp" aborted ebenfalls.
- **Kein Abort bei "stop the music"**: kein Abort, normaler Steer.
- **Stop bei idle**: "stop" → normaler Turn, keine Bestätigung.
- **Doppel-Nachrichten-Szenario (Incident)**: zwei schnelle Nachrichten → genau ein konsistenter Turn (jeder Text genau einmal), dritte Nachricht während Turn → Steer, kein zweiter Turn.

`packages/core/tests/agent.test.ts`:
- **Stop während Tool-Call**: `controller.abort("user")` während Tool-Exec → Tool läuft zu Ende, Result `{ aborted: true, reason: "user" }`, genau 1 LLM-Call (kein weiterer).
- Bestehende `signal`-Abort-Tests bleiben unverändert grün (`reason: "signal"`).

Entfernt: alle 4 Abort-and-Restart-Tests (Restart, Steer nach Tool-Call, Max-2-Restarts, >5s).

`packages/agent/tests/daemon/runtimeWhatsAppProgressive.test.ts`: Signatur `submitWhatsAppTurn` um optionales `signal` erweitert (kompatibel).

## Validierung

- `pnpm -r typecheck` grün (core + agent)
- `pnpm -C packages/core build` grün
- Tests: `packages/core/tests/agent.test.ts` (43), `inbound.test.ts` (32), `runtimeWhatsAppProgressive.test.ts` (4), retryIntegration/agentResilience/compaction grün
- Bekannte pre-existing Flakes (sudo `exec.test.ts`, `non-tty.test.ts`) können rot bleiben
