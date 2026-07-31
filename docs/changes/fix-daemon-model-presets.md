# fix: TUI model presets reach daemon

## Problem

The TUI `/model` picker showed the selected preset (e.g. DeepSeek Pro) in the
status bar, but daemon-backed sessions always ran `defaultModel` (Flash).
`submit-turn` ignored the `model` field even though it existed in the IPC type.

## Fix

- TUI passes `activeModel.id` on `create-session` and every `submit-turn`
- Daemon resolves presets from `config.models` by alias, model id, or
  `provider/model`, then calls `agent.setModel()` before each turn
- Session entry stores `modelRef` so the choice persists across turns
- `DaemonClientBackend.supportsModelSwitching` is now `true`

## Files

- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/src/backends/daemonClientBackend.ts`
- `packages/agent/src/backends/types.ts`
- `packages/agent/src/cli/App.tsx`
- `packages/agent/src/cli/help.ts`
