# Voice v1.2 — Report-Back an die Main-Session + Outbound-Grußverhalten

## Problem/Symptom

Live belegt: Der Voice-Agent sagte im Call "ich halte das für die
Mainsession fest" — in der Main-Session kam nichts an. Es gab keinen
Rückkanal aus einem Call: Der Agent spricht nur mit dem Angerufenen (TTS/STT),
Ergebnisse/Beschlüsse erreichten die Main-Session nie.

Zweitens (Betreiber, live): Bei Outbound legte der Agent sofort mit dem
Briefing los, bevor der Angerufene bereit war; sprach der Angerufene
dazwischen, brach der Fluss.

Drittens: Das Abschluss-Event gab es nur für Outbound-Calls und nur mit
Volltext ("Anruf an X beendet") — Inbound-Calls hinterließen gar kein Signal
in der Main-Session.

## Lösung

### 1. Neues Tool `report_to_main_session` (`packages/core/src/tools/report_to_main_session.ts`, neu)

- Parameter: `text` (string, TS strict, kein `any`).
- Capability-Injection wie `call_user`/`send_file`: `voiceReportToMainSession`
  im `ToolCallContext` (`packages/core/src/tools/types.ts`), durchgereicht
  über `RunOptions` (`packages/core/src/core/agent.ts`).
- Capability wird **NUR in Voice-Sessions** injiziert
  (`submitVoiceTurn`); in jeder anderen Session liefert das Tool einen
  klaren Error ("Kein Voice-Call aktiv").
- Registriert in `registry.ts` + `lib.ts`.

### 2. Daemon-Delivery (`packages/agent/src/daemon/runtime.ts`)

`voiceReportToMainSession` injiziert ein System-Event in die
Main-WhatsApp-Session des Owners (Muster: event-bus):

```text
[Voice-Call voice-<ts>] <text>
```

- `origin` = `Voice-Call`, `text` = `[Voice-Call <sessionId>] <text>`.
- Zielauflösung: bei Outbound die **anfordernde Session** via
  `whatsappSessionToSource` (Fallback `ownerPhone` — im Outbound-Tracking
  vermerkt, NICHT `resolveOwnerPhone` neu auflösen, v1.1-Bug).
- Der Caller-Kontext (`currentVoiceSessionCaller`) wird pro Voice-Turn
  gesetzt/gecleart — das Tool wirkt nur während eines laufenden Turns.

### 3. Abschluss-Event verallgemeinert

`onVoiceCallEnded` (neu, ersetzt den Outbound-Sonderweg) feuert bei JEDEM
Call-Ende — auch Inbound:

```text
Anruf beendet (Dauer X, Grund Y). Transkript: Session voice-<ts>.
```

Signal, kein Volltext — der Main-Agent liest das Transkript bei Bedarf über
Tools. Outbound → anfordernde Chat-Session, Inbound → Owner-Main-Session.
`VoiceChannel.finishCall` ruft dafür den neuen `onCallEnded`-Callback auf.

### 4. Voice-Addendum (`packages/agent/src/daemon/channelAddendum.ts`)

- Basis-Addendum ergänzt: "Wenn dein Gegenüber dich bittet, etwas der
  Main-Session zu übermitteln, nutze sofort report_to_main_session. Fasse am
  Call-Ende wichtige Ergebnisse/Beschlüsse als kompakten Report für die
  Main-Session zusammen (wie ein Subagent-Report)."
- Outbound-Addendum (neu, nur im ersten Transkript-Turn):
  "Du hast angerufen. Warte, bis dein Gegenüber sich zuerst meldet. Dann:
  kurze Begrüßung, danach dein Anliegen aus dem Briefing."

### 5. Outbound-Grußverhalten (`packages/agent/src/daemon/runtime.ts`)

`onOutboundVoiceCallStarted` setzt das Briefing **nicht mehr** sofort als
`submitVoiceTurn` ab:

- Briefing wird für die Voice-Session vorgemerkt (Briefing-Flag im
  Outbound-Tracking).
- Beim **ersten eingehenden Final-Transkript** wird es als Kontext in diesen
  Turn gegeben: `<briefing>\n\n[Der Angerufene sagt:] <transkript>` +
  Outbound-Addendum. Danach ist das Flag konsumiert.
- Fallback: meldet sich der Angerufene **30 s lang nicht**, eröffnet der
  Agent per einfachem Timer (`outboundVoiceFallbacks`):
  `Hallo, hörst du mich?\n\nBriefing:\n<briefing>`.
- Erstes Transkript oder Call-Ende canceln den Timer.

## Welche Dateien

- `packages/core/src/tools/report_to_main_session.ts` (neu)
- `packages/core/src/tools/types.ts`
- `packages/core/src/tools/registry.ts`
- `packages/core/src/lib.ts`
- `packages/core/src/core/agent.ts`
- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/src/daemon/voiceChannel.ts`
- `packages/agent/src/daemon/channelAddendum.ts`
- `docs/voice-ipc.md`

### Tests (neu/erweitert)

- `packages/core/tests/tools/report_to_main_session.test.ts` (neu, 4 Tests)
- `packages/agent/tests/daemon/voiceRuntime.test.ts` (+8 Tests)
- `packages/agent/tests/daemon/voiceChannel.test.ts` (+2 Tests)

## Tests

- Tool-Gate: ohne Capability (Nicht-Voice-Session) → klarer Error.
- Event-Routing: Report landet in der korrekten Session (Owner /
  Outbound-Requester via `phoneOverride`).
- Event-Format: `[Voice-Call voice-<ts>] <text>`, `origin: Voice-Call`.
- Abschluss-Event für inbound UND outbound (inkl. `isOutbound`-Flag im
  Channel-Callback).
- Kein `say`/Turn vor dem ersten Transkript bei Outbound; Briefing-Inhalt
  ist im Turn nach dem ersten Transkript enthalten; nur der erste Turn trägt
  das Briefing; 30-s-Fallback feuert den Opening-Turn; erstes Transkript
  cancelt den Fallback-Timer.
