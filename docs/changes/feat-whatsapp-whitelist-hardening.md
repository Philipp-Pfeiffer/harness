# feat: WhatsApp Whitelist Hardening & Sender Provenience

**Date:** 2026-08-08

## Problem

A security audit verified the whitelist enforcement is correctly placed (plugin.ts:234, before model/loop access) with proper silent drop. Two gaps were identified:

1. **Number normalization:** `extractPhoneNumber()` did not strip `+`, spaces, or other non-digit characters. A `WHATSAPP_WHITELIST_NUMBER=+491701234567` would not match `491701234567@s.whatsapp.net`.
2. **Missing sender identity (provenance):** Inbound WhatsApp messages were injected into the user message without any structural marker distinguishing external channel input from the system prompt. No `untrusted` or channel-provenance tagging.

## What changed

### 1. Number normalization hardening (`whitelist.ts`)

- Added `normalizeNumber()`: strips all non-digit characters (`replace(/\D/g, "")`) for deterministic comparison.
- `isWhitelisted()` now normalizes both sides: incoming JID *and* configured whitelist number.
- Backward compatible: all existing call sites and tests unchanged.

### 2. Whitelist extends to number→name map (`whitelist.ts`)

- New env var `WHATSAPP_WHITELIST`: JSON map `{"491701234567":"Philipp", ...}`.
- `isWhitelisted()` checks the map first; falls back to legacy `WHATSAPP_WHITELIST_NUMBER`.
- New `resolveSenderName(jid)`: returns configured name from the map, or `+49170…` as fallback.
- `hasWhitelist()` updated to cover both config modes.

### 3. Sender provenance prefix (`inbound.ts`, `plugin.ts`, `types.ts`)

- `ChannelInboundEvent` now has optional `senderName` field.
- `handleInboundMessage()` (plugin.ts) sets `senderName` via `resolveSenderName()` after whitelist check, before processor dispatch.
- `flushDebounced()` (inbound.ts) prepends `[WhatsApp · Philipp] ` (or `[WhatsApp · +49170…]`) to the combined text before submitting the turn.
- The prefix is the first token in the user message, giving the model structural awareness of the channel and sender.
- Steer path (after tool call or max restarts) does NOT get the prefix — it pushes raw text to the mailbox.

### Files changed

| File | Change |
|---|---|
| `packages/agent/src/whatsapp/whitelist.ts` | `normalizeNumber()`, `resolveSenderName()`, map-based whitelist, digits-only comparison |
| `packages/agent/src/whatsapp/plugin.ts` | Import `resolveSenderName`, set `senderName` on event |
| `packages/agent/src/whatsapp/inbound.ts` | Provenance prefix in `flushDebounced()` |
| `packages/agent/src/daemon/types.ts` | `senderName?` on `ChannelInboundEvent` |
| `packages/agent/src/whatsapp/index.ts` | Barrel exports for new functions |
| `packages/agent/tests/whatsapp/whitelist.test.ts` | 12 new tests: normalization, map, resolveSenderName, legacy compat |
| `packages/agent/tests/whatsapp/inbound.test.ts` | 3 new provenance prefix tests, fixed 3 exact-text assertions |
| `docs/architecture/whatsapp-gateway.md` | Document new env var, provenance prefix |
| `.env.example` | Updated to show `WHATSAPP_WHITELIST` as primary format |

### Tests

- `pnpm -r test`: 405 tests, all passing (38 files).
- `pnpm typecheck`: clean.
- `pnpm build`: clean.

### Config format

```bash
# New (recommended)
WHATSAPP_WHITELIST='{"4915112345678":"Philipp","447700900123":"Anna"}'

# Legacy (still supported)
WHATSAPP_WHITELIST_NUMBER=4915112345678
```
