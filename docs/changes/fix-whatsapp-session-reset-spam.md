# fix: WhatsApp session-reset spam on daemon start

## Problem

Starting the daemon flooded WhatsApp with dozens of identical messages:
`[Neue Session gestartet — vorheriger Kontext wurde zurückgesetzt.]`

## Root cause

Two bugs combined:

1. **History replay:** Baileys `messages.upsert` with `type: "append"` replays chat history on connect. Harness treated every replayed message as a new inbound turn.
2. **Race on session resolve:** Concurrent `resolveWhatsAppSession()` calls (one per replayed message) each created a new session and sent the reset notice before the in-memory map was populated.

## Fix

- Process only `type: "notify"` upserts (realtime messages), skip `append` history sync.
- Serialize `resolveWhatsAppSession()` per phone number via `PerKeyLock`.
- Send the reset notice only when replacing a session after the 8h inactivity threshold — not on daemon restart, first contact, or index lookup failure.
- Rotate live WhatsApp sessions after 8h inactivity while the daemon keeps running (compact + end old session, create new, notify once).

## Files

- `packages/agent/src/whatsapp/client.ts`
- `packages/agent/src/whatsapp/sessionPolicy.ts`
- `packages/agent/src/util/perKeyLock.ts`
- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/tests/whatsapp/sessionPolicy.test.ts`

## Tests

```bash
CI=true pnpm --filter @harness/agent test tests/whatsapp/sessionPolicy.test.ts
```
