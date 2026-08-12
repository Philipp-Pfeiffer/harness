# Voice-IPC — Thin-Adapter-Protokoll

> Single Source of Truth für die Kommunikation zwischen dem Harness-Daemon
> und dem WhatsApp-Voice-Adapter (`whatsappcallomat`).
>
> Der Adapter ist ein **dummer Audio-Adapter**: `zapo-js`/`@zapo-js/voip` +
> STT + TTS + Call-Lifecycle, **rein Text über IPC**. Agent, Sessions,
> Persona, Memory, Tools und Skills liegen vollständig im Daemon. Voice-Calls
> sind normale Harness-Sessions im regulären Session-Store.

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

// Outbound-Call — v1 definiert/typiert nur; Implementierung = v1.1.
{"type":"start_call","callId":"...","jid":"...","briefing":"..."}
```

## Session-Mapping

- Ein Call ist eine Session mit der ID `voice-<callStartTs>` (ms-Epoch des
  `call_started`-`ts`). `origin = "voice"`.
- `call_started` legt die Session an; `transcript`-Nachrichten werden als
  normale Turns über die reguläre submit-turn-Queue des Daemons verarbeitet
  (kein Sonderpfad — Persona, Memory, Tools, Skills greifen automatisch).
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
