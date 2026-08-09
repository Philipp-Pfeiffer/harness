# fix-lid-device-suffix

**Commit:** d301efe
**Datum:** 2026-08-09

## Problem

Agent-Antworten per WhatsApp kamen zwar auf dem Handy an, aber WhatsApp Web zeigte "Warte auf diese Nachricht" an — die Nachrichten konnten dort nicht entschlüsselt werden. Restart/Deploy-Pings hingegen funktionierten einwandfrei auf allen Clients.

## Befund

Die beiden Sendepfade nutzten unterschiedliche JID-Formate:

| Pfad | JID | Quelle |
|------|-----|--------|
| Restart/Deploy-Ping | `4915110619636@s.whatsapp.net` | `formatJid(replyTarget)` — reine Nummer + `@s.whatsapp.net` |
| Agent-Outbound | `4915110619636:0@s.whatsapp.net` | LID-Resolution via Baileys — `resolveLidToPn()` gibt `:0` Device-Suffix zurück |

Das `:0` Device-Suffix selektiert einen anderen Session-Key-Pair in Baileys und verursacht ein Entschlüsselungs-Problem auf WhatsApp Web/Desktop (das die Session-Keys anders validiert als das Handy).

Der gleiche Fixversuch in den vorherigen zwei Deploys (syncFullHistory, markOnlineOnConnect, composing-Presence) scheiterte, weil der tatsächliche Unterschied tiefer lag — im JID-Format, nicht in den Socket-Optionen.

## Fix

In `packages/agent/src/whatsapp/plugin.ts`, `handleInboundMessage()`: Nach erfolgreicher LID→PN-Resolution wird ein eventueller `:N` Device-Suffix via Regex aus der JID entfernt.

```typescript
const cleanPun = pn.replace(/:(\d+)@/, "@");
```

Damit verwenden beide Pfade identische JIDs (`4915110619636@s.whatsapp.net`).

## Geänderte Dateien

- `packages/agent/src/whatsapp/plugin.ts`

## Verifikation

- Build: `tsc` clean
- Manueller Test: Agent-Antwort kam direkt auf WhatsApp Web an, kein "Warte"-Indicator
- Log-Bestätigung: `LID PN had device suffix, stripped: 4915110619636:0@s.whatsapp.net → 4915110619636@s.whatsapp.net`
