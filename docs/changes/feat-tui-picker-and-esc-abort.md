# feat: TUI viewport picker and Esc turn abort

## Problem

1. Model/session pickers rendered every list row at once, exceeding terminal height with many entries — items below the fold were unreachable.
2. Only Ctrl+C could abort an in-flight turn; Esc closed menus but could not cancel running work. Session logs did not distinguish user aborts from errors.

## Changes

### Viewport-constrained picker (`packages/agent/src/cli/picker.ts`, `ViewportPicker.tsx`)

- Reusable `ViewportPicker` component with scroll windowing, `▲ N more` / `▼ N more` overflow indicators, Up/Down/PgUp/PgDn navigation.
- fzf-style subsequence fuzzy filter (Backspace edits filter; selection resets on filter change).
- Uses `termSize.rows` and reacts to terminal resize (existing stdout `resize` listener).
- Migrated model picker, session picker, and slash-command autocomplete to the shared component.

### Esc aborts current turn

- **TUI:** Esc aborts an in-flight turn (idle Esc still closes pickers). Double-abort guarded via `abortingRef`. Brief `turn aborted` status line shown.
- **Agent loop:** `AbortSignal` passed via `ToolCallContext.signal`; in-flight tools cancelled (`exec` kills process group; browser sub-agent propagates parent abort).
- **Browser sub-agent:** Parent abort → synthesized failure report (`aborted by user`); partial sandbox downloads cleaned up on abort.
- **Daemon IPC:** Socket close / client abort wires `AbortSignal` into `agent.run()`.
- **Session log:** `SessionTurn.aborted` and `SessionTurn.truncated` markers; partial assistant text preserved in `content`.

## Files

| Area | Files |
|------|-------|
| Picker | `packages/agent/src/cli/picker.ts`, `ViewportPicker.tsx`, `App.tsx` |
| Abort core | `packages/core/src/core/agent.ts`, `tools/types.ts`, `tools/exec.ts`, `tools/browser.ts`, `browser/runner.ts`, `browser/sandbox.ts` |
| Backends | `inProcessBackend.ts`, `daemonClientBackend.ts`, `daemon/ipc.ts`, `daemon/runtime.ts` |
| Session | `packages/agent/src/core/session.ts` |
| Tests | `packages/agent/tests/cli/picker.test.ts`, `packages/agent/tests/core/sessionAbort.test.ts`, `packages/core/tests/agentAbortTool.test.ts`, `packages/core/tests/browser/runnerAbort.test.ts` |

## Tests

- `picker.test.ts` — fuzzy filter, viewport windowing, key navigation
- `agentAbortTool.test.ts` — abort signal reaches tool context
- `runnerAbort.test.ts` — browser sub-agent synthesized abort failure
- `sessionAbort.test.ts` — `aborted` / `truncated` persisted in JSONL transcript
