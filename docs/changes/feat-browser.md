# feat: agentic browser subsystem

## Problem

The main agent had no way to interact with JavaScript-rendered pages. `web_fetch` is HTTP-only with no browser rendering.

## Solution

Added a browser subsystem in `@harness/core` that delegates browsing to a dedicated sub-agent via a single `browser` tool on the main agent.

### Architecture
- **Engine:** `playwright-core` with `chromium.connectOverCDP()` (Obscura, headless Chrome, or any CDP endpoint)
- **Main tool:** `browser` — spawns sub-agent, waits for `submit_report`, returns structured report
- **Sub-agent tools:** `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_tabs`, `browser_download`, `take_note`, `submit_report`
- **Security:** URL denylist (SSRF), download sandbox with magic-byte verification, untrusted content delimiters
- **Config:** `browser` key in `config.json`, `BROWSER_CDP_URL` env override

### Files
- `packages/core/src/browser/` — session manager, engine, sandbox, runner
- `packages/core/src/tools/browser.ts` — main agent tool factory
- `packages/core/prompts/browser-agent.md` — sub-agent system prompt
- `packages/agent/agents/browser/agent.md` — profile reference

### Tests
- `packages/core/tests/browser/` — unit tests (mock CDP) + integration gated by `BROWSER_INTEGRATION=1`
