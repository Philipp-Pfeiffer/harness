# Voice-IPC — Thin-Adapter-Protokoll

> Single Source of Truth für die Kommunikation zwischen dem Harness-Daemon
> und dem WhatsApp-Voice-Adapter (`whatsappcallomat`).
>
> Der Adapter ist ein **dummer Audio-Adapter**: `zapo-js`/`@zapo-js/voip` +
> STT + TTS + Call-Lifecycle, **rein Text über IPC**. Agent, Sessions,
> Persona, Memory, Tools und Skills liegen vollständig im Daemon. Voice-Calls
> sind normale Harness-Sessions im regulären Session-Store.
>
> Version: v1.3 (Voice Cold-Start: Accept-After-Ready + Begrüßung mit Anrufer-Kontext)

## Transport

- **Medium**: Unix-Socket unter `$HARNESS_STATE/voice.sock`
  (Default `~/.harness/voice.sock`; der Adapter kann den Pfad via
  `VOICE_SOCKET_PATH` überschreiben. Beide Seiten lösen den Pfad identisch
  auf: `$HARNESS_STATE` → `$XDG_STATE_HOME/harness` → `~/.harness`.)
- **Framing**: NDJSON — genau ein JSON-Objekt pro Zeile, getrennt durch `\n`.
- **Rollen**:
  - **Daemon = Server**: lauscht auf dem Socket, verwaltet den Lifecycle
    zusammen mit dem Daemon (startet/stoppt mit `DaemonRuntime`).
  - **Adapter = Client**: verbindet und hält die Verbindung; bei Verlust
    Reconnect mit exponentiellem Backoff (max 30 s).

## Nachrichten

Alle Nachrichten tragen ein `type`-Feld. Unbekannte Felder müssen toleriert
werden (forward-kompatibel). Unbekannte `type`-Werte werden geloggt und
ignoriert.

### Adapter → Daemon

```jsonc
// Nach jedem (Re)Connect — Resync der aktiven Calls. Der Daemon nimmt
// laufende Calls mit einer frischen Session wieder auf.
{"type":"hello","activeCalls":[{"callId":"...","from":"+49...","since":1699999999999}]}

// Inbound-Call klingelt (VOR dem Accept): der Daemon generiert die
// Begrüßung (Anrufer-Kontext → System-Addendum) und antwortet mit `say`,
// BEVOR `call_started` (accepted) eintrifft. Der Adapter puffert das
// Greeting-Audio und nimmt den Call erst an, wenn es gepuffert ist oder
// das Fallback-Timeout abläuft (Accept-After-Ready, v1.3).
{"type":"call_ringing","callId":"...","from":"+49...","ts":1699999999999}

// Neuer Call (nach Accept).
{"type":"call_started","callId":"...","from":"+49...","direction":"inbound","ts":1699999999999}

// NUR Finals (end_of_turn), keine Partials.
{"type":"transcript","callId":"...","text":"..."}

// Call beendet (Peer aufgelegt oder Adapter-Hangup).
{"type":"call_ended","callId":"...","reason":"..."}

// Call-Fehler (vollständiger Teardown erfolgt im Adapter).
{"type":"call_error","callId":"...","error":"..."}
```

### Daemon → Adapter

```jsonc
// Agent-Antwort → TTS → Feed. callId steuert das Routing an den richtigen Socket.
{"type":"say","callId":"...","text":"..."}

// Bot-seitiges Auflegen.
{"type":"end_call","callId":"...","reason":"..."}

// Outbound-Call — IMPLEMENTIERT (v1.1). Der Daemon initiiert den Anruf;
// der Adapter wählt, meldet call_started (direction=outbound) und später
// call_ended. jid = <digits>@s.whatsapp.net, briefing = Seed-Text der
// ersten Voice-Turn (Begrüßung + Bericht).
{"type":"start_call","callId":"...","jid":"...","briefing":"..."}
```

## Outbound-Eventfluss (v1.1)

`call_user`-Tool → Daemon → Adapter → Anruf → zurück:

1. Der Agent ruft das `call_user`-Tool mit `number` (internationales Format)
   und `briefing` auf.
2. Der Daemon normalisiert die Nummer auf Ziffern und prüft die
   **fail-closed Registry** `$HARNESS_HOME/voice-registry.json`. Nicht
   gelistet / Datei fehlt / kaputt → Tool-Error, **kein** Anruf.
3. Der Daemon prüft das **Rate-Limit** (max. 1 Call pro Nummer pro 10 Min,
   persistiert in `$HARNESS_STATE/voice-ratelimit.json`). Verstoß →
   Tool-Error mit Wartezeit.
4. Bei Erfolg sendet der Daemon `start_call{callId, jid, briefing}` an den
   Adapter und legt eine Voice-Session `voice-<ts>` an.
5. Der Adapter mappt `jid` → `CallRouter.callOutbound`, wählt und meldet
   `call_started{direction:"outbound"}` zurück.
6. Der Daemon seedet das `briefing` als erste Turn der Voice-Session — der
   Agent eröffnet mit Begrüßung + Bericht, ohne auf User-Input zu warten.
   Progressive `say`-Nachrichten (Zwischen-Texte vor Tool-Calls) und die
   finale Antwort werden wie bei Inbound-Turns gesprochen.
7. Beim Auflegen sendet der Adapter `call_ended{reason}` (inkl.
   `no-answer`/`timeout`). Der Daemon injiziert ein System-Event
   ("Anruf an <Name/Nummer> beendet, Dauer X, Grund Y") in die anfordernde
   Chat-Session.

## Outbound-Grußverhalten (v1.2)

Der Agent eröffnet Outbound-Calls NICHT mehr sofort mit dem Briefing — der
Angerufene soll zuerst bereit sein:

1. `onOutboundCallStarted` merkt das Briefing nur vor (kein `submitVoiceTurn`).
2. Beim **ersten eingehenden Final-Transkript** wird das Briefing als Kontext
   in diesen Turn gegeben:
   `<briefing>\n\n[Der Angerufene sagt:] <transkript>`.
   Der erste Turn trägt zusätzlich das Outbound-Addendum ("Du hast angerufen.
   Warte, bis dein Gegenüber sich zuerst meldet. Dann: kurze Begrüßung, danach
   dein Anliegen aus dem Briefing.").
3. Fallback: meldet sich der Angerufene **30 s lang nicht**, eröffnet der
   Agent selbst per Timer:
   `Hallo, hörst du mich?\n\nBriefing:\n<briefing>`.

## Report-Back an die Main-Session (v1.2)

### Tool `report_to_main_session`

Der Voice-Agent kann Inhalte an die Main-WhatsApp-Session des Owners melden —
es gibt sonst keinen Rückkanal aus einem Call:

- Parameter: `text` (string).
- Capability `voiceReportToMainSession` wird **nur in Voice-Sessions**
  injiziert; in jeder anderen Session liefert das Tool einen klaren Error.
- Delivery: System-Event in die Main-WhatsApp-Session des Owners
  (Muster: event-bus; bei Outbound die anfordernde Session via
  `whatsappSessionToSource`, Fallback `ownerPhone`).

### Event-Format

```text
[Voice-Call voice-<ts>] <text>
```

`origin` = `Voice-Call`; das Event wird wie jedes System-Event als
`[System · Voice-Call]` präfixiert und über den regulären Event-Bus injiziert
(Turn läuft → Mailbox-Steering; Session idle → synthetisches Inbound-Event).

### Abschluss-Event (jeder Call, auch Inbound)

Bei JEDEM Call-Ende injiziert der Daemon ein kompaktes Signal in die
Main-Session (Outbound: anfordernde Chat-Session):

```text
Anruf beendet (Dauer X, Grund Y). Transkript: Session voice-<ts>.
```

Das ist ein **Signal, kein Volltext** — der Main-Agent kann das Transkript bei
Bedarf über Tools lesen (Session `voice-<ts>` im Session-Store).

## Inbound-Cold-Start: Accept-After-Ready + Begrüßung mit Anrufer-Kontext (v1.3)

Ziel: Der Anrufer hört die Begrüßung sofort nach dem Accept (≤ ~0,5 s), und
die Begrüßung kennt den Anrufer ("Hallo Philipp …").

Ablauf (Inbound):

1. Der Adapter empfängt `call_incoming` (Ringing) — **noch kein** `acceptCall`.
2. Der Adapter sendet `call_ringing{callId, from, ts}` und wärmt STT auf
   (best-effort).
3. Der Daemon legt die Voice-Session bereits hier an (`voice-<ts>`), löst die
   Nummer über `resolveVoiceContact` (`$HARNESS_HOME/voice-registry.json`;
   unbekannt → `null` → Fallback auf die Roh-Nummer) auf und startet einen
   **Opening-Turn OHNE Fake-User-Message**: der Name wird als
   System-Addendum injiziert ("X ruft gerade an. Sprich sofort eine kurze
   Begrüßung …"), das Voice-Addendum kommt dazu.
4. Der Daemon sendet die Begrüßung als `say` — **VOR** `call_started`.
5. Der Adapter synthetisiert die Begrüßung per TTS und **puffert** das Audio
   (kein `feedLiveAudio` vor dem Accept — der VoIP-Stack verwirft das).
6. Der Adapter ruft `acceptCall` genau dann auf, wenn (a) Begrüßungs-Audio
   gepuffert ist ODER (b) das Fallback-Timeout abläuft
   (`INBOUND_GREETING_TIMEOUT_MS`, Default 3 s — damit klingelt es nie endlos,
   auch wenn der Daemon hängt).
7. Danach sendet der Adapter `call_started{..., direction:"inbound"}` und
   feedet das gepufferte Audio sofort; ab dann normaler Live-Betrieb
   (transcript → say).
8. Bricht der Anrufer vor der Annahme ab, sendet der Adapter `call_ended`
   ohne jemals `acceptCall` gerufen zu haben.

Bekommt der Daemon ein `call_ringing` für eine Nummer, die er kennt, nutzt er
`voice-registry.json` (gleiches Format wie das Outbound-Gate, aber **fail-open**:
unbekannt ist kein Fehler, nur ein Namens-Fallback).

## Session-Mapping

- Ein Call ist eine Session mit der ID `voice-<callStartTs>` (ms-Epoch des
  `call_started`-`ts`). `origin = "voice"`.
- `call_ringing` legt die Session bereits an (Begrüßung kann sofort
  zugestellt werden); `call_started` nutzt die bestehende Session.
- `transcript`-Nachrichten werden als normale Turns über die reguläre
  submit-turn-Queue des Daemons verarbeitet (kein Sonderpfad — Persona,
  Memory, Tools, Skills greifen automatisch).
- `call_ended` beendet die Session; In-Call-History ergibt sich aus der
  normalen Session, keine Sonderbehandlung.
- Der Agent-Antworttext einer abgeschlossenen Turn wird als `say` an den
  richtigen `callId`-Socket geschrieben.

## Daemon-Restart während eines Calls

Calls überleben im Adapter eine Session im Daemon nicht. Nach einem
Daemon-Restart gilt:

1. Adapter reconnectet und sendet `hello` mit `activeCalls`.
2. Der Daemon legt für jeden laufenden Call eine **frische** Voice-Session
   an (`voice-<ts>` des `hello`-`since`-Felds).
3. Nachfolgende `transcript`-Nachrichten landen in dieser neuen Session.

Das ist akzeptiert — bewusst **kein** komplexes Resume.

## Fehler-Semantik

- `call_error` bedeutet: der Adapter hat den Call bereits vollständig
  abgeräumt (STT/TTS geschlossen, Feed-Queue geleert, ggf. `endCall`). Der
  Daemon soll nur noch die Session abschließen und loggen.
- Eine `transcript`-Nachricht für eine unbekannte `callId` wird geloggt und
  verworfen (kein Crash, kein Side-Effect).
