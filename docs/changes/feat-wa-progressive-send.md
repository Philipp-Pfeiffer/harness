# feat: Progressives WhatsApp-Senden während des Agent-Turns

## Problem

Der Agent sendete auf WhatsApp nur EINE Nachricht am Turn-Ende. Bei
"Text → Tool-Call → weiterer Text"-Abläufen sah Philipp erst das Endergebnis,
nicht den Zwischenstand. Das TUI-Streaming existierte bereits, WhatsApp
jedoch nicht.

## Befund

- `submitWhatsAppTurn` in `packages/agent/src/daemon/runtime.ts` rief
  `agent.run()` OHNE `onEvent`-Callback auf — die von der Run-Loop bereits
  produzierten Text-Chunks (`AgentEvent.type === "token"`) wurden verworfen.
- Die finale Antwort sendet weiterhin der `WhatsAppInboundProcessor` über
  `sendOutbound` bei Turn-Completion (`inbound.ts`).
- `sendAgentResponse`/`sendOutbound` waren bereits mehrfach pro Turn
  aufrufbar — es gab keine Beschränkung auf turn-complete. Es fehlte nur der
  Hook, der Zwischentexte an den Channel schickt.

## Änderungen

### `packages/agent/src/daemon/runtime.ts`

- `submitWhatsAppTurn` registriert jetzt einen `onEvent`-Hook an
  `agent.run()`. Text, der VOR einem Tool-Call produziert wird, wird bei
  `tool_call_start` akkumuliert und über `plugin.sendMessage(formatJid(source),
  { text })` sofort an den WhatsApp-Kanal gesendet — dann läuft der Tool-Call.
- Sends sind serialisiert (`sendChain`), damit mehrere progressive Segmente
  ihre Reihenfolge behalten. Fehler beim Senden werden geloggt, nie geworfen —
  ein Send-Fehler bricht den Turn nicht ab.
- Text NACH dem letzten Tool-Call wird NICHT progressiv gesendet: Das ist die
  finale Antwort, die der Inbound-Processor nach Turn-Completion genau einmal
  via `sendOutbound` sendet.
- Vor dem Return wird `sendChain` awaited, damit die finale Antwort des
  Inbound-Processors erst nach allen progressiven Segmenten ankommt.
- Keine Änderung am Agent-Loop (`agent.ts`), an der Tool-Execution oder am
  TUI-Streaming. Der IPC-Pfad (`submit-turn` mit eigenem `onEvent` für das
  Streaming) bleibt unberührt.

### Fix: Duplikat der finalen Antwort (Deploy-Test, 10.8.2026)

Nach dem ersten Deploy kam die finale Antwort doppelt: Der finale Flush
sendete den letzten Text-Teil progressiv, der Inbound-Processor sendete
dieselbe finale Antwort nochmal. Ursache: Der Flush griff auch auf Text nach
dem letzten Tool-Call zu. Fix: Progressive Delivery stoppt bei
`tool_call_start` — Text nach dem letzten Tool-Call wird ausschließlich vom
Inbound-Processor gesendet (siehe oben).

### Nicht geändert (bewusst)

- `packages/agent/src/whatsapp/plugin.ts` — der `sendOutbound`-Callback
  existierte bereits und sendet via `sendAgentResponse`. Die progressive
  Delivery nutzt den kürzeren `plugin.sendMessage`-Weg direkt, da der
  Channel-Pipeline-Render (`renderToChannel`) für den Turn-Ende-Pfad
  reserviert ist.
- `packages/core/src/core/agent.ts` — der Run-Loop emittierte `token`-Events
  bereits; es musste nur ein Konsument angeschlossen werden.

## Tests

Neu: `packages/agent/tests/daemon/runtimeWhatsAppProgressive.test.ts`

- "text + tool + text"-Pattern → nur der Text VOR dem Tool-Call wird
  progressiv gesendet; Text nach dem letzten Tool-Call (finale Antwort) wird
  NICHT gesendet (kein Duplikat).
- Zwei Tool-Calls → jedes Pre-Tool-Segment wird als eigene Nachricht gesendet.
- Agent ohne Zwischentext → kein progressiver Send.
- Kein Channel-Plugin registriert → Hook ist No-Op, Turn schließt normal ab.

Verifikation: `pnpm typecheck` grün, `pnpm build` grün, WhatsApp/daemon-Suite
(282 Tests) grün. Einzig pre-existing Fail: `exec.test.ts` (sudo-Test ohne
Passwort auf dieser Maschine) — unabhängig von dieser Änderung.
