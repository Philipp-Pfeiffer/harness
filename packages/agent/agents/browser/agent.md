---
name: browser
tools: browser_navigate, browser_snapshot, browser_click, browser_type, browser_screenshot, browser_tabs, browser_download, take_note, submit_report
memory:
skills: false
maxTokens: 4096
---
Internal browser sub-agent profile reference. The browser subsystem spawns sub-agent sessions programmatically — this file documents the intended tool allowlist.

**Browser engine:** Obscura (CDP). Harness spawns `obscura serve` per session and stops it when the session ends (`browser.mode: "obscura"`, default).

**Model:** Not loaded from this profile. Runtime uses `browser.model` from config.json, or falls back to `defaultModel`. Set `browser.model` explicitly for a cheaper browsing model.
