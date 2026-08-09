# fix: Flake in voice-Tests unter CPU-Last (withTimers-Verhungern)

## Problem

`packages/agent/tests/whatsapp/voice.test.ts` lief unter paralleler CPU-Last (Daemon-Tests bzw. Daemon-Prozess im Hintergrund) sporadisch in den 20s-Timeout:

```
FAIL tests/whatsapp/voice.test.ts > transcribeVoice > returns the transcript text on success
Error: Test timed out in 20000ms.
```

Ein weiterer Timeout-Bump war ausdrücklich keine Option (bloße Symptom-Kur).

## Befund

Der `withTimers`-Helper führt bis zu **200 sequenzielle** `await vi.advanceTimersByTimeAsync(3000)`-Iterationen aus, bis die `transcribeVoice`-Promise resolved. Jede Iteration läuft durch den Mikrotask-Queue-Loop von Vitest's Fake Timers; unter Last (langsamer Event-Loop) kann der 20s-Test-Timeout verstreichen, bevor die 10–20 real nötigen Iterationen durch sind. Der Fehler tritt also nicht im Produktcode auf, sondern im Test-Fake-Timer-Setup.

## Fix

`transcribeVoice` in `packages/agent/src/whatsapp/voice.ts` bekommt einen **optionalen Options-Parameter**, abwärtskompatibel:

```typescript
interface VoiceTranscriptionOptions {
  pollIntervalMs?: number; // Default 3000 (heutiger Wert)
  pollTimeoutMs?: number;  // Default 60 * 3000 (heutige 60 Versuche)
}

transcribeVoice(filePath: string, options: VoiceTranscriptionOptions = {}): Promise<VoiceTranscriptionResult>
```

- Der Poll-Loop ist jetzt zeitbasiert (`do-while` über `Date.now()`-Budget) statt iterationsbasiert (`for attempt < 60`). Bei Defaults ist das Verhalten identisch (~3 min Budget).
- Produktion (`plugin.ts`) ruft weiterhin ohne Options auf → keine Änderung im Public-Export/Verhalten.
- Die 3 Poll-Tests (`transcription-error`, `timeout`, `success`) übergeben `{ pollIntervalMs: 5, pollTimeoutMs: 50 }` → `withTimers` ist nach 1–2 statt bis zu 200 Iterationen fertig; das Verhungern unter Last ist beseitigt, die Test-Semantik (welcher Status welche Rückgabe erzeugt) unverändert.

## Dateien

- `packages/agent/src/whatsapp/voice.ts` — `VoiceTranscriptionOptions`, Options-Parameter, zeitbasierter Poll-Loop
- `packages/agent/tests/whatsapp/voice.test.ts` — 3 Poll-Tests mit winzigen Intervallen
- `docs/changes/fix-voice-poll-flake.md` — dieser Report

## Tests

Validierung im Worktree (Daemon läuft parallel = Lastfall):

- `pnpm build` — grün
- `pnpm typecheck` — grün
- `CI=true pnpm --filter @harness/agent test` — **5/5 Läufe grün**, 470 Tests / 45 Files pro Lauf

Kein Push, kein Daemon-Restart.
