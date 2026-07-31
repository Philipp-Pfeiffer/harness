# feat: agentic browser subsystem

## Problem

The main agent had no way to interact with JavaScript-rendered pages. `web_fetch` is HTTP-only with no browser rendering.

## Solution

Added a browser subsystem in `@harness/core` that delegates browsing to a dedicated sub-agent via a single `browser` tool on the main agent.

### Architecture
- **Engine:** [Obscura](https://github.com/obscura-browser/obscura) headless browser via `playwright-core` CDP
- **Lifecycle:** Default `browser.mode: "obscura"` spawns `obscura serve` per browser session and kills the process on `disconnect()`
- **Main tool:** `browser` — spawns sub-agent, waits for `submit_report`, returns structured report
- **Sub-agent tools:** `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_tabs`, `browser_download`, `take_note`, `submit_report`
- **Security:** URL denylist (SSRF), download sandbox with magic-byte verification, untrusted content delimiters
- **Config:** `browser` key in `config.json`, `OBSCURA_PATH` / `BROWSER_CDP_URL` env overrides

### Files
- `packages/core/src/browser/obscura.ts` — managed Obscura spawn, CDP readiness probe, teardown
- `packages/core/src/browser/engine.ts` — Playwright CDP engine
- `packages/core/src/browser/` — session manager, sandbox, runner
- `packages/core/src/tools/browser.ts` — main agent tool factory
- `packages/core/prompts/browser-agent.md` — sub-agent system prompt
- `packages/agent/agents/browser/agent.md` — profile reference

### Tests
- `packages/core/tests/browser/obscura.test.ts` — spawn/teardown unit tests (mocked)
- `packages/core/tests/browser/engine.test.ts` — engine lifecycle with injected Obscura
- `packages/core/tests/browser/` — url/sandbox/snapshot/runner unit tests
- Integration gated by `BROWSER_INTEGRATION=1` (requires Obscura installed)
