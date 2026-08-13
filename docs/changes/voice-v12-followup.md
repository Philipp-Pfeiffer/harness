# Voice v1.2-Follow-up: Hangup-Fix, hang_up-Tool, Inbound-Gruß, Timing (Daemon-Seite)

## Problem/Symptom

Live-Test 13.08. 16:03–16:06 (nach v1.2-Deploy): Der Farewell-Hangup-Pfad
endete nicht mehr — der Agent sagte "Alles klar, dann verabschiede ich mich…"
(16:05:02) und "Jetzt lege ich richtig auf…" (16:05:25), aber es kam kein
`endCall`; der Betreiber musste selbst auflegen (16:05:43, `user_ended`).
Zudem: kein Pfad für ein bot-seitiges Auflegen auf expliziten User-Wunsch
("leg auf") außer Regex-Glück; und bei Inbound-Calls meldete der Betreiber
"er sagt nichts, bis ich was sage".

## Root Cause (Forensik, Beleg in `~/.harness/logs/daemon-2026-08-13.log` + journalctl)

Die Farewell-Erkennung lief (16:05:02 `Farewell erkannt (Pattern)`), aber der
TTS-`onDone`-Callback kam nie zuverlässig durch: Nach der letzten Synthese
wurde der TTS-Stream durch eine neue `synthesize()`-Sequenz abgebrochen
(AbortError), sodass der `onDone`-Pfad → `Drain-Wait` → `endCall` nie feuerte.
Der `Drain-Wait` hatte außerdem keine harte Obergrenze mit echtem
Fortschritts-Tracking — ein hängender Feed-Queue/Puffer konnte ihn unbegrenzt
blockieren. Damit waren Farewell UND (im Verbund) der Silence-Hangup
blockiert: Der laufende TTS/Drain-Kontext hielt die Session so lange aktiv.

## Lösung (Daemon-Seite)

### 1. `hang_up`-Tool (`packages/core/src/tools/hang_up.ts`, neu)

Deterministischer Weg für "User bittet aufzulegen": Der Agent verabschiedet
sich und ruft das Tool auf → Runtime sendet per IPC `end_call` (reason
`agent_requested`) an den Adapter.

- `ToolCallContext.voiceHangUp` (Core) — Capability nur in Voice-Sessions
  injiziert, alle anderen Session-Typen bekommen einen klaren Tool-Error.
- Runtime: `voiceCallSessionsBySession` (sessionId→callId) + `voiceHangUp()`
  → `voiceChannel.endCall(callId, "agent_requested")`.
- Registry + `lib.ts`-Export.

### 2. Addendum (`packages/agent/src/daemon/channelAddendum.ts`)

Voice-Addendum ergänzt: "Wenn dein Gegenüber dich bittet aufzulegen,
verabschiede dich kurz und beende das Gespräch." — als verlässlicher
Regex-Backstop zusätzlich zum Tool.

### 3. Timing-Logging

Strukturierte `voice-timing:`-Zeilen (component `voice`): `turn_start`,
`first_text_block`, `turn_end` (`turnMs`), `say_sent` — jede Zeile mit
`callId` + `sessionId`. Format siehe `docs/changes/voice-timing.md`.

## Welche Dateien

- `packages/core/src/tools/hang_up.ts` (neu)
- `packages/core/src/tools/types.ts` (ToolCallContext.voiceHangUp)
- `packages/core/src/tools/registry.ts`, `packages/core/src/lib.ts`
- `packages/agent/src/daemon/runtime.ts` (voiceHangUp, Session-Mapping, Timing)
- `packages/agent/src/daemon/voiceChannel.ts` (Timing: transcript_final_received/turn_end/say_sent)
- `packages/agent/src/daemon/channelAddendum.ts` (Leg-auf-Instruktion)
- `docs/changes/voice-timing.md` (neu, Format-Doku)

### Tests

- `packages/agent/tests/daemon/voiceRuntime.test.ts` (+3: hang_up ok,
  hang_up ohne Session, voice-timing-Zeilen)
- `packages/agent/tests/daemon/voiceChannel.test.ts` (Timing-Assertions)
- `packages/agent/tests/daemon/channelAddendum.test.ts` (Leg-auf-Addendum)

## Tests

- `pnpm build` ✓, `pnpm typecheck` ✓
- `CI=true vitest run packages/core packages/agent`: 1243 passed, 3 bekannte
  prä-existente Rots (exec-sudo, obscura-timeout, whatsapp-snapshot)
