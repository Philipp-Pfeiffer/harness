# Voice-Farewell-Timing + Outbound-Kontext

## Ziel

Zwei Verbesserungen am Voice-Call-Fluss (nur Daemon-Seite, `packages/agent` +
`packages/core`):

1. **Farewell-Timing**: `hang_up` legt erst auf, NACHDEM der Agent seinen
   Abschied (die LLM-generierte finale Antwort) gesprochen hat. Vorher ging
   `end_call` sofort raus, noch bevor der Abschied generiert/gesprochen war.
2. **Outbound-Kontext**: Der erste Outbound-Turn bekommt den Präfix
   `Du rufst <Name> an.` vor das Briefing, damit der Agent weiß, wen er
   gerade anruft (Name aus der Registry, sonst Nummer).

## TEIL 1 — hang_up legt erst NACH dem gesprochenen Abschied auf

### Sequenz (Daemon → Adapter)

```
say (finale Antwort / Abschied)  →  Adapter spricht + drained Audio-Queue  →  end_call
```

Der Adapter (`call-session.ts`) verarbeitet `say` über `onSay` (TTS +
Backpressure-Drain) und `end_call` über `onEndCall` (sofortiges Auflegen).
Damit der Abschied hörbar bleibt, muss `end_call` zwingend **nach** der
finalen `say` gesendet werden — nie davor.

### Umsetzung

- **`packages/core/src/tools/hang_up.ts`** + **`types.ts`**: `hang_up` ruft
  weiterhin die Capability `voiceHangUp`, aber die Capability sendet NICHT
  mehr sofort `end_call`.
- **`packages/agent/src/daemon/runtime.ts`**:
  - `voiceHangUp` setzt nur noch das per-Session-Flag `pendingHangup`
    (`pendingHangupSessions`).
  - Neuer `afterVoiceFinalSay`-Hook: nach der finalen `say` (oder ohne `say`
    bei leerem Turn) wird der aufgeschobene Hangup finalisiert.
  - `finalizePendingHangup` sendet `end_call` **genau einmal** (Set-Guard →
    kein Doppel-`end_call`, z.B. bei konkurrierendem Farewell-Regex-Pfad).
  - **Leerer Turn** (kein `finalMessage`, z.B. abgebrochen): `end_call` wird
    nach `PENDING_HANGUP_FALLBACK_MS` (1500 ms) nachgeholt.
- **`packages/agent/src/daemon/voiceChannel.ts`**: neuer Callback
  `afterFinalSay(callId, sessionId, finalResponse)`, aufgerufen NACH dem
  `say`-Push. Dadurch ist die Reihenfolge-Garantie (`say` vor `end_call`)
  an einer einzigen Stelle verankert.

### Unverändert

- Der **Farewell-Regex-Pfad** im Adapter bleibt unverändert (`isFarewell` →
  `pendingFarewellHangup` → TTS-Ende + Grace → Auflegen).
- Das **Voice-Addendum** bleibt: „Wenn dein Gegenüber dich bittet aufzulegen,
  verabschied dich kurz und beende das Gespräch mit dem Tool hang_up."

## TEIL 2 — Outbound-Kontext-Präfix

### Umsetzung

- **`packages/agent/src/daemon/voiceRegistry.ts`** (neu): `resolveVoiceContact`
  liest `voice-registry.json` und liefert den Kontaktnamen oder `null`.
  `STUB — Dedupliziere beim Merge mit Track A.`
- **`packages/agent/src/daemon/runtime.ts`**:
  - `voiceCallerLabel(number)` löst die Zielnummer über `resolveVoiceContact`
    auf (unbekannt → Nummer).
  - Beim **ersten Transkript-Turn** wird der Kontext um den Präfix erweitert:

    ```text
    Du rufst <Name> an.

    <briefing>

    [Der Angerufene sagt:] <transkript>
    ```

  - Beim **30-s-Fallback** wird der Präfix ebenso vorangestellt:

    ```text
    Du rufst <Name> an.

    Hallo, hörst du mich?

    Briefing:
    <briefing>
    ```

  - Der Name wird einmalig in `onOutboundVoiceCallStarted` aufgelöst und im
    Outbound-Eintrag (`outbound.label`) vorgemerkt, damit der Fallback-Timer
    synchron (ohne erneuten Datei-I/O) darauf zugreifen kann.

## Tests

- `packages/core/tests/tools/hang_up.test.ts` (neu): Tool delegiert an die
  Capability, Fehlerfall ohne Capability, Fehler-Weiterleitung.
- `packages/agent/tests/daemon/voiceChannel.test.ts`: `afterFinalSay` wird
  nach dem `say` gefeuert (auch bei leerem Turn).
- `packages/agent/tests/daemon/voiceRuntime.test.ts`:
  - `hang_up` setzt nur `pendingHangup` (kein sofortiges `end_call`)
  - `end_call` kommt erst nach der finalen `say`
  - Fallback bei leerem Turn
  - kein Doppel-`end_call` (Guard)
  - Outbound-Präfix: Name aus Registry + Nummer-Fallback, beide Pfade
- `packages/agent/tests/daemon/voiceOutbound.test.ts`: `resolveVoiceContact`
  (Name, unbekannt → null, fehlende Datei → null).

## Offene Punkte

- `resolveVoiceContact` ist ein **Stub**; beim Merge mit Track A muss die
  Duplikat-Auflösung erfolgen (genau eine Implementierung behalten).
- Der `PENDING_HANGUP_FALLBACK_MS` (1500 ms) ist eine konservative Frist für
  leere Turns; bei Bedarf über Umgebungsvariable konfigurierbar machen.
