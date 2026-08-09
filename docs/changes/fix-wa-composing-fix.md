# fix: WhatsApp composing-Presence aus Inbound-Turn entfernen

## Problem/Symptom

Agent-Antworten auf WhatsApp blieben in "Warte auf diese Nachricht" hängen.

## Befund

Sendepfad-Audit: Alle WhatsApp-Textpfade enden in derselben `sock.sendMessage(jid, { text })`. Der Unterschied zwischen Restart-Ping (ankommend) und Agent-Antwort (hängt) ist TIMING.

`plugin.ts` sendete `sendPresenceUpdate("composing")` zu Beginn jedes Inbound-Turns. Bei 30–120s LLM-Latenz läuft dieser Status aus → WhatsApp markiert das Gerät als unresponsive → die spätere Antwort bleibt in "Warte auf diese Nachricht" hängen.

## Fix

- `composing`-Presence-Update zu Beginn des Inbound-Turns **entfernt** (Z. 251–258 in `plugin.ts`). Das Senden nur bei erwarteter Antwort <15s ist ohne Vorab-Wissen über die LLM-Latenz nicht praktikabel.
- `sendTyping` vollständig aus dem Client entfernt (Interface, Baileys-Implementierung, Mock), da nach dem Entfernen des einzigen Aufrufers tot.

## Dateien

- `packages/agent/src/whatsapp/plugin.ts`
- `packages/agent/src/whatsapp/client.ts`

## Tests

- `pnpm build`, `pnpm typecheck` grün
- `CI=true pnpm --filter @harness/agent test` grün
- Keine Tests asserten auf `sendTyping`/`composing`
