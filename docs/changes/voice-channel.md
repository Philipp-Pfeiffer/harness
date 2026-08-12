# Voice-Integration v1 — Daemon-Seite (Thin-Adapter)

## Problem/Symptom

Der WhatsApp-Voice-PoC lief bisher komplett im Adapter-Repo (`whatsappcallomat`)
mit einem eigenen Mini-Agenten (`createAgent` mit `tools: []`). Damit fehlten
Persona, Memory, Tools und Skills — der Voice-Agent war ein Stummel, und die
Agent-Logik war dupliziert.

## Lösung

Thin-Adapter-Architektur: Der Adapter wird ein **dummer Audio-Adapter**
(VoIP + STT + TTS + Call-Lifecycle), der **rein Text über IPC** mit dem
Daemon spricht. Der Daemon besitzt Agent und Sessions — Voice-Calls sind
normale Harness-Sessions im regulären Session-Store.

Das geteilte Protokoll ist in `docs/voice-ipc.md` dokumentiert (Single Source
of Truth).

## Was geändert wurde

### Protokoll (`docs/voice-ipc.md`, neu)

Unix-Socket unter `$HARNESS_STATE/voice.sock` (Default `~/.harness/voice.sock`),
NDJSON (eine JSON-Zeile pro Nachricht). Daemon = Server, Adapter = Client mit
Reconnect (exponentieller Backoff, max 30 s).

- Adapter→Daemon: `hello` (Resync), `call_started`, `transcript` (nur Finals),
  `call_ended`, `call_error`.
- Daemon→Adapter: `say` (Agent-Antwort → TTS), `end_call` (bot-seitiges
  Auflegen), `start_call` (v1.1, nur typisiert).

### Session-Mapping

Ein Call ist eine Session mit der ID `voice-<callStartTs>` (`origin = "voice"`).
`call_started` legt die Session an, `transcript`-Nachrichten laufen über die
normale submit-turn-Queue, `call_ended` beendet die Session. Kein Sonderpfad —
Persona, Memory, Tools, Skills greifen automatisch.

### Voice-Channel (`packages/agent/src/daemon/voiceChannel.ts`, neu)

`VoiceChannel`-Klasse: IPC-Server (Unix-Socket), startet/stoppt mit dem
Daemon-Lifecycle. Parst eingehende NDJSON-Zeilen und dispatcht `hello`,
`call_started`, `transcript`, `call_ended`, `call_error`. Routed Agent-Antworten
(`say`) an den richtigen `callId`-Socket. `finishCall()` räumt
Call→Session-Mappings auf.

### Daemon-Wiring (`packages/agent/src/daemon/runtime.ts`)

- `resolveVoiceSession()`: legt `voice-<ts>`-Sessions an bzw. reused sie.
- `submitVoiceTurn()`: Transkripte als Turns submitten, Antwort via
  `voiceChannel.say()` zurück.
- `endVoiceSession()`: Session abschließen + Mappings leeren.
- `start()`/`shutdownWithExit()`: Voice-Channel starten/stoppen.

### System-Prompt-Addendum (`packages/agent/src/daemon/channelAddendum.ts`)

`origin === "voice"` → TTS-verträgliches Addendum (kurze Sätze, gesprochene
Sprache, KEIN Markdown/Listen/Code/URLs, lange Tool-Aktionen verbal ankündigen).

### Core (`packages/core/src/config/paths.ts`)

- `paths.voiceSocketFile` = `$STATE/voice.sock`.

### Session (`packages/agent/src/core/session.ts`)

- `SessionOrigin` um `"voice"` erweitert.
- `CreateSessionOptions.id` optional — erlaubt explizite Session-IDs
  (`voice-<callStartTs>`).

### Daemon-Restart während eines Calls

Calls überleben im Adapter keine Session im Daemon. Nach Restart sendet der
Adapter `hello` mit `activeCalls`; der Daemon legt frische Voice-Sessions an.
Akzeptiert — bewusst kein komplexes Resume.

## Welche Dateien

- `docs/voice-ipc.md` (neu)
- `packages/agent/src/daemon/voiceChannel.ts` (neu)
- `packages/agent/src/daemon/runtime.ts` (erweitert)
- `packages/agent/src/daemon/channelAddendum.ts` (erweitert)
- `packages/agent/src/daemon/types.ts` (erweitert)
- `packages/agent/src/core/session.ts` (erweitert)
- `packages/core/src/config/paths.ts` (erweitert)

### Tests (neu)

- `packages/agent/tests/daemon/voiceChannel.test.ts`
- `packages/agent/tests/daemon/voiceRuntime.test.ts`
- `packages/agent/tests/daemon/channelAddendum.test.ts` (voice-Origin ergänzt)

## Tests

- `voiceSessionId`-Mapping, `call_started`/`transcript`→Turn-Fluss,
  `say`-Routing, `hello`-Resync, unbekannte-Calls-Drop, `call_ended`/`call_error`.
- Runtime-Level: `resolveVoiceSession` (Create/Reuse), `submitVoiceTurn`
  (Voice-Addendum-Injektion + say-Routing), `endVoiceSession`.
- Bestehende Suites bleiben grün (bekannter Umgebungs-Rot:
  `packages/core/tests/tools/exec.test.ts` > "elevated > id -u").
