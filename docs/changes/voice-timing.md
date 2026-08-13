# Benchmark-Timing-Logging (Voice v1.2)

## Ziel

Pro Voice-Turn messbare Segment-Dauern der Latenz-Pipeline
(STT-Endpunkterkennung → LLM → TTS → Playback), damit Verzögerungen
bezifferbar sind — ohne Extra-Agent, rein über den bestehenden Log-Strom.

## Format

Alle Timing-Zeilen sind **eine JSON-Zeile pro Event** (NDJSON, component
`voice-timing`), in den bestehenden Log-Strom geschrieben:

- **Daemon:** `~/.harness/logs/daemon-<datum>.log`, component `voice`
  (Child-Logger). Feld `msg` beginnt mit `voice-timing:`.
- **Adapter:** systemd-Unit-Log (`journalctl --user -u harness-voice.service`),
  `onLog`-Zeilen. `msg` beginnt mit `[timing]`.

### Daemon-seitige Events (`voiceChannel.ts` / `runtime.ts`)

| Event | Format | Bedeutung |
|---|---|---|
| `transcript_final_received` | `voice-timing: transcript_final_received callId=<c> sessionId=<s>` | Final-Transkript vom Adapter angekommen |
| `turn_start` | `voice-timing: turn_start callId=<c> sessionId=<s>` | Agent-Turn beginnt (submitVoiceTurn) |
| `first_text_block` | `voice-timing: first_text_block callId=<c> sessionId=<s>` | Erstes progressives Text-Block-Event an `say` |
| `turn_end` | `voice-timing: turn_end callId=<c> sessionId=<s> turnMs=<n>` | Agent-Turn beendet (`turnMs` = ms seit turn_start) |
| `say_sent` | `voice-timing: say_sent callId=<c> sessionId=<s>` | Finale Antwort über den Voice-Channel an den Adapter gesendet |

`callId`/`sessionId` stehen in **jeder** Zeile. `turnMs` ist eine
Millisekunden-Zahl.

### Adapter-seitige Events (`call-session.ts`, Präfix `[timing]`)

| Event | Format | Bedeutung |
|---|---|---|
| `transcript_sent` | `[timing] transcript_sent ms=<n>` | Final-Transkript über IPC gesendet (STT-Ende erkannt) |
| `turn_start` | `[timing] turn_start synth=<k> ms=<n>` | `say` vom Daemon empfangen; `synth` = laufender TTS-Zähler |
| `tts_first_chunk` | `[timing] tts_first_chunk ms=<n> since_say=<n>` | Erster Audio-Chunk nach `say` (`since_say` = ms) |
| `feed_pause` | `[timing] feed_pause ms=<n> buffered=<n>` | Backpressure: Feed pausiert, Drain startet |
| `feed_rtt` | `[timing] feed_rtt ms=<n>` | RTT-Zeitstempel pro 320-Sample-Slice (max. 1x/s) |
| `drain_done` | `[timing] drain_done ms=<n> capped=<bool>` | Drain fertig; `capped=true` = 10-s-Cap griff |

Alle `ms`-Werte sind monotonic (unabhängig von Wanduhr/Sommerzeit), hier als
Millisekunden-Zahl.

## Auswertung (awk/grep-Beispiele)

Alle Daemon-Timing-Zeilen anzeigen:

```bash
grep 'voice-timing:' ~/.harness/logs/daemon-$(date +%F).log
```

Adapter-Timing-Zeilen (aus dem systemd-Log):

```bash
journalctl --user -u harness-voice.service --since '10 min ago' | grep '\[timing\]'
```

Pipeline eines einzelnen Turns nachvollziehen (Daemon):

```bash
grep 'voice-timing:' ~/.harness/logs/daemon-$(date +%F).log \
  | grep 'callId=<c>'
```

`turnMs` (LLM-Segment-Dauer) pro Turn als Tabelle:

```bash
grep 'voice-timing: turn_end' ~/.harness/logs/daemon-$(date +%F).log \
  | sed -E 's/.*callId=([^ ]+) sessionId=([^ ]+) turnMs=([0-9]+).*/\1 \2 \3/'
```

Adapter: TTS-Segment-Dauer (`since_say` zwischen `turn_start` und
`tts_first_chunk`):

```bash
journalctl --user -u harness-voice.service | grep '\[timing\]' \
  | grep -E 'turn_start|tts_first_chunk'
```

## Welche Dateien

- `packages/agent/src/daemon/voiceChannel.ts` (transcript_final_received, turn_end, say_sent)
- `packages/agent/src/daemon/runtime.ts` (turn_start, first_text_block, say_sent)
- Adapter-Repo: `src/voice/call-session.ts` (transcript_sent, turn_start, tts_first_chunk, feed_pause, feed_rtt, drain_done)
