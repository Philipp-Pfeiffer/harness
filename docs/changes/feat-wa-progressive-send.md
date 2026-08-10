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

### Fix: WhatsApp Presence (Online-Status + "tippt…") (10.8.2026)

Nach dem Deploy des progressiven Sendens meldete Philipp: kein Online-Status
mehr sichtbar, "tippt…"-Indikator unreliable.

Befund:

- `markOnlineOnConnect: false` (seit `199c25e`) bewirkte, dass Baileys bei
  jedem Connect automatisch `sendPresenceUpdate("unavailable")` sendet
  (Baileys `chats.js`, `connection.open`-Handler). Das explizite
  `setPresence("available")` des Plugins verlor das Race gegen dieses
  automatische `unavailable` → Online-Status verschwand.
- Der progressive Send (`plugin.sendMessage`) während eines laufenden Turns
  kann WhatsApps composing-Zustand zurücksetzen; der 15s-Refresh des
  Inbound-Processors war zu langsam, um das zu korrigieren → "tippt…"
  flackerte.

Fix:

- `client.ts`: `markOnlineOnConnect: true` — Baileys sendet "available" selbst
  beim Connect; kein Kampf mehr mit automatischem `unavailable`.
- `plugin.ts`: explizites `setPresence("available")` bei `open` entfernt
  (redundant). `unavailable` bei `close` bleibt. Plugin-`setPresence` akzeptiert
  jetzt auch `composing`/`paused` mit JID.
- `daemon/types.ts`: `ChannelPlugin.setPresence`-Signatur um
  `composing`/`paused` erweitert.
- `runtime.ts`: Nach jedem progressiven Send wird `setWhatsAppPresence(
  "composing", jid)` sofort erneut gefeuert (fire-and-forget), damit das
  "tippt…" trotz Send sichtbar bleibt. `setWhatsAppPresence` leitet jetzt auch
  `composing`/`paused` an das Plugin weiter (vorher nur account-weit).

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
(498 Tests) grün. Einzig pre-existing Fail: `exec.test.ts` (sudo-Test ohne
Passwort auf dieser Maschine) — unabhängig von dieser Änderung.
