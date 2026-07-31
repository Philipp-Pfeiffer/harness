# fix: browser tool IPC timeout

## Problem

`browser` tool runs a full sub-agent (Obscura + multiple LLM turns). The TUI/daemon IPC client timed out after 120s with no activity, even though the daemon was still working.

## Fix

- Submit-turn IPC idle timeout increased to 10 minutes (`SUBMIT_TURN_IPC_TIMEOUT_MS`)
- Idle timer resets on each `turn-event` (activity-based timeout)
- Browser sub-agent emits `status` progress (`browser: connecting`, `browser: browser_snapshot`, …) to keep IPC alive and show progress in the TUI
- Daemon forwards `status` agent events over IPC

## Files

- `packages/agent/src/daemon/ipc.ts`
- `packages/agent/src/backends/daemonClientBackend.ts`
- `packages/agent/src/daemon/runtime.ts`
- `packages/core/src/tools/types.ts`, `packages/core/src/core/agent.ts`
- `packages/core/src/browser/runner.ts`, `packages/core/src/tools/browser.ts`
