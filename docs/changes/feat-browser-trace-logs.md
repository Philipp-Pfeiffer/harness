# feat: browser sub-agent trace logs

## Problem

Browser tool results in the main session only contained the final `submit_report`
markdown. Internal sub-agent steps (snapshots, clicks, navigations) were not
persisted and could not be reviewed after the fact.

## Fix

Each `browser` tool invocation writes a JSONL trace under
`$HARNESS_STATE/browser-runs/<sessionId>/<runId>.jsonl`.

Logged events:
- `run-start` — input goal, URL, toolCallId link to main session
- `phase` — connecting, navigating, disconnected
- `turn-start` / `turn-end`
- `tool-call-start` / `tool-call-done` / `tool-call-error` (snapshots truncated)
- `run-end` — goal achieved, token usage, failure reason

The main agent tool result appends the trace path at the bottom.

## Files

- `packages/core/src/browser/trace.ts`
- `packages/core/src/browser/runner.ts`
- `packages/core/src/config/paths.ts` (`browserRuns`)
- `packages/core/src/tools/browser.ts`, `types.ts`, `registry.ts`
- `packages/core/src/core/agent.ts` (`toolCallId` in context)
- `packages/agent/src/daemon/runtime.ts`, `index.tsx`
- `packages/core/tests/browser/trace.test.ts`
