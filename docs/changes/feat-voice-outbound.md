# Voice v1.1 — Outbound-Calls, progressive Sprachausgabe, fail-closed Allowlist

## Problem/Symptom

Der Voice-Channel (v1) konnte nur **eingehende** Anrufe annehmen. Es gab keinen
Weg, einen Anruf zu **initiieren**. Zusätzlich hörte der Angerufene bei
Tool-Arbeit **Stille** — nur die finale Turn-Antwort wurde gesprochen, die
Ankündigungs-Texte vor Tool-Calls gingen unter. Und die Inbound-Allowlist des
Adapters war **fail-open** (leer = alle erlauben).

## Lösung

Drei Bausteine:

1. **`call_user`-Tool** (Daemon): Outbound-Calls mit **Registry-Gate**
   (fail-closed) und **Rate-Limit**, Briefing als erster Turn-Seed.
2. **Progressive Sprachausgabe**: Während eines Voice-Turns wird der
   Agent-Event-Stream beobachtet; abgeschlossene Zwischen-Texte (Textsegment,
   dem Tool-Calls folgen) werden **sofort** als `say` gesprochen.
3. **Fail-closed Allowlist** (Adapter): `ALLOWED_NUMBERS` leer → alle
   eingehenden Calls ablehnen + Warn-Log beim Start.

## Was geändert wurde

### `call_user`-Tool (`packages/core/src/tools/call_user.ts`, neu)

- Parameter: `number` (internationales Format), `briefing` (vom Agenten
  formuliert, orientiert den Angerufenen sofort: wer/warum/worum).
- Normalisiert die Nummer auf Ziffern und delegiert an die
  `voiceCallStarter`-Capability. Ohne Capability (kein Voice-Channel aktiv) →
  klarer Tool-Error. Tool-Description erklärt WhatsApp-Sprachanruf,
  Registry-Nummern, Rate-Limit und Briefing-Zweck.
- Capability-Injektion wie `send_sticker`: `voiceCallStarter` im
  `ToolCallContext` (`packages/core/src/tools/types.ts`), durchgereicht über
  `RunOptions` (`packages/core/src/core/agent.ts`).

### Registry-Gate + Rate-Limit (`packages/agent/src/daemon/voiceOutbound.ts`, neu)

- Registry `$HARNESS_HOME/voice-registry.json` (Format
  `{"contacts":[{"number","name?","note?"}]}`), **fail-closed**: nicht
  gelistet / Datei fehlt / kaputt → Error.
- Rate-Limit: max. 1 Call pro Nummer pro 10 Min, persistiert in
  `$HARNESS_STATE/voice-ratelimit.json` (restart-sicher).
- Pfade ergänzt in `packages/core/src/config/paths.ts`
  (`voiceRegistry`, `voiceRatelimit`).

### Daemon-Wiring (`packages/agent/src/daemon/runtime.ts`)

- `voiceCallStarter`-Capability: Registry-Gate → Rate-Limit → `start_call`
  über IPC, Outbound-Call-Tracking (`outboundVoiceCalls`).
- `onOutboundVoiceCallStarted`: seedet das Briefing als erste Turn
  (Begrüßung + Bericht, ohne User-Input); spricht die finale Antwort.
- `onOutboundVoiceCallEnded`: injiziert System-Event
  ("Anruf an <Name/Nummer> beendet, Dauer X, Grund Y") in die anfordernde
  Chat-Session (via `whatsappSessionToSource`, Fallback ownerPhone).

### Progressive Sprachausgabe (`packages/agent/src/daemon/voiceChannel.ts` + `runtime.ts`)

- `VoiceChannel` bekommt Outbound-Callbacks (`onOutboundCallStarted`,
  `onOutboundCallEnded`), `startCall()` broadcastet `start_call` an den
  Adapter (neue Outbound-Calls haben noch kein callId→Socket-Mapping).
- `submitVoiceTurn` puffert Text-Tokens und sendet sie beim ersten
  `tool_call_start`-Event als `say` (Muster: progressive WhatsApp-Send).
  Finale Antwort unverändert am Turn-Ende.

### Voice-Addendum (`packages/agent/src/daemon/channelAddendum.ts`)

- Ergänzt: "Kündige kurz verbal an, bevor du Tools benutzt (z.B. 'Ich schaue
  kurz nach'), damit dein Gegenüber weiß, dass du arbeitest."

### Adapter (`whatsappcallomat`)

- `start_call`-Handler: `number` → JID (`<digits>@s.whatsapp.net`),
  Busy-Check (Concurrency 1), `CallRouter.callOutbound`; Outcome-Events
  (`call_started direction=outbound`, `call_ended` mit `reason` inkl.
  `no-answer`/`timeout`) zurück.
- `CallSession` unterscheidet interne `callId` (zapo) und logische
  `ipcCallId` (Daemon) für korrektes IPC-Routing.
- **Fail-closed Allowlist**: `allowedNumbers` leer → alle Inbound-Calls
  rejecten + Warn-Log beim Start.

## Welche Dateien

Harness (Worktree `feat/voice-outbound`):

- `packages/core/src/tools/call_user.ts` (neu)
- `packages/core/src/tools/types.ts`
- `packages/core/src/core/agent.ts`
- `packages/core/src/tools/registry.ts`
- `packages/core/src/lib.ts`
- `packages/core/src/config/paths.ts`
- `packages/agent/src/daemon/voiceOutbound.ts` (neu)
- `packages/agent/src/daemon/voiceChannel.ts`
- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/src/daemon/channelAddendum.ts`
- `docs/voice-ipc.md`

Adapter (`whatsappcallomat`, Branch `feat/outbound`):

- `src/voice/router.ts`
- `src/voice/call-session.ts`
- `src/index.ts`
- `.env.example`

### Tests (neu/erweitert)

- `packages/core/tests/tools/call_user.test.ts` (neu)
- `packages/agent/tests/daemon/voiceOutbound.test.ts` (neu)
- `packages/agent/tests/daemon/voiceChannel.test.ts` (Outbound erweitert)
- Adapter: `src/voice/router.test.ts` (neu)

## Tests

- `call_user`: Normalisierung, Happy-Path, keine Capability/Session, leeres
  Briefing, Capability-Fehler.
- `voiceOutbound`: Registry (valid/missing/corrupt/wrong-shape/empty),
  `findRegistryContact`, Rate-Limit inkl. Persistenz (restart-sicher).
- `voiceChannel`-Outbound: `start_call`-Broadcast, Outbound-Callbacks
  (started/ended), Inbound triggert keine Outbound-Callbacks.
- Adapter `router`: JID-Mapping, Busy-Reject, `failed`-Reason, fail-closed
  Allowlist (leer → reject + Warn, nicht-gelistet → reject, gelistet → accept).
