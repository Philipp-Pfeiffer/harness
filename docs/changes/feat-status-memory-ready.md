# feat: `/status` Memory-Anzeige im Daemon verdrahten

## Problem

Der WhatsApp-`/status` (via `handleChannelSlashCommand` im Daemon) zeigte
`Memory: n/a`, weil `memoryReady` in `buildStatusSummary` nicht gesetzt wurde.
Nur die TUI übergab den tatsächlichen Zustand (`!memoryService?.degraded`).

## Was geändert wurde

- **`packages/agent/src/daemon/runtime.ts`**
  - `/status`-Handler übergibt jetzt
    `memoryReady: this.memoryService ? !this.memoryService.degraded : false`
    an `buildStatusSummary` — analog zur TUI (`cli/App.tsx`).
  - Erwartung: `Memory: ready` im WhatsApp-`/status`, wenn der Service läuft und
    nicht degraded; `Memory: n/a` sonst.

## Dateien

- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/tests/daemon/modelRef.test.ts` (enthält die `/status`-Tests)

## Tests

- `tests/daemon/modelRef.test.ts` (neu, 2 `/status`-Tests):
  - `memoryService` vorhanden + `degraded: false` → Antwort enthält `Memory: ready`.
  - `memoryService` mit `degraded: true` → Antwort enthält `Memory: n/a`.
- `pnpm build`, `pnpm typecheck`, `pnpm --filter @harness/agent test` grün.
