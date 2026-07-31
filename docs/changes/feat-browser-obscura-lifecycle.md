# feat: managed Obscura browser lifecycle

## Problem

Browser subsystem required manually starting `obscura serve` (or fell back to Chromium). Original spec called for Obscura as the browser engine with automatic process management.

## Solution

- Default `browser.mode` is now `obscura`
- On browser session start: allocate free port → spawn `obscura serve --port <port>` → wait for CDP `/json/version`
- On session end (`engine.disconnect()`): close Playwright CDP connection → SIGTERM/SIGKILL Obscura child process
- `mode: "cdp"` remains for attaching to an external CDP server (debug only)

## Files

- `packages/core/src/browser/obscura.ts` — spawn, readiness probe, teardown
- `packages/core/src/browser/errors.ts` — shared browser errors
- `packages/core/src/browser/engine.ts` — Obscura-only connect path
- `packages/core/src/browser/config.ts`, `packages/core/src/config.ts` — config schema
- `packages/core/tests/browser/obscura.test.ts`, `engine.test.ts` — unit tests
- `README.md`, `docs/changes/feat-browser.md`

## Tests

```bash
CI=true pnpm --filter @harness/core test tests/browser
BROWSER_INTEGRATION=1 pnpm --filter @harness/core test tests/browser/integration.test.ts
```
