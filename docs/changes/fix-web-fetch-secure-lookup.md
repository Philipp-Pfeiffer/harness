# fix: web_fetch secure DNS lookup callback

## Problem

`web_fetch` failed with `Fetch failed: fetch failed` for all public URLs
(e.g. `https://example.com`), while `curl` and plain `fetch()` worked.

## Befund

`createSecureLookup()` always called the DNS callback as
`(err, address, family)`. undici passes `{ all: true }` and expects
`(err, addresses[])` instead. Node then received a string where it expected
an address array → `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`.

## Fix

- Respect `opts.all` in the secure lookup callback
- Filter private IPs from the full address list when `all: true`
- Integration test: `fetch("https://example.com")` via secure dispatcher

## Files

- `packages/core/src/tools/webSecurity.ts`
- `packages/core/tests/tools/webSecurity.test.ts`
