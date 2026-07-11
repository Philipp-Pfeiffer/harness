# Bugfix-Pass: Daemon Startup + CLI-Hygiene

**Datum:** 2026-07-11
**Branch:** `feature/daemon`
**Worktree:** `~/dev/harness-daemon`

## P0 — Daemon startet nicht (CRITICAL)

### Problem

`node dist/index.js daemon run` initialisierte (Memory/QMD-Bootstrap lief durch) und
exitet dann sauber zum Shell-Prompt. Keine IPC-Listen-Meldung, kein PID-File,
kein `daemon_start`-Log.

### Root Cause

`daemonRun()` in `src/daemon/commands.ts` returnte nach `await runtime.start()`
ein `CliResult`-Objekt. Zurück in `src/index.tsx` rief der `case "run":` Block
`process.exit(exitCode)` auf — der Daemon wurde sofort nach dem Start gekillt.

Zusätzlich war die Wartezeit in `daemonStart()` nur 500ms (fester Sleep), was
für den Memory/QMD-Bootstrap zu kurz war — der PID-File war noch nicht
geschrieben, wenn `daemonStart` bereits prüfte.

### Fix

**`src/daemon/commands.ts` — `daemonRun()`:**
- Return-Typ von `Promise<CliResult>` → `Promise<void>`.
- `try/catch` um `runtime.start()`: Startup-Exceptions werden auf `stderr`
  ausgegeben (inkl. Stack-Trace), dann `process.exit(1)`.
- Nach erfolgreichem Start: `process.stderr.write` mit PID + Socket-Pfad.
- `await new Promise<never>(() => {})` — blockiert forever; der Prozess
  exitet nur über Signal-Handler → `runtime.shutdown()` → `process.exit(0)`.

**`src/daemon/commands.ts` — `daemonStart()`:**
- 500ms fester Sleep → Polling-Loop (50 × 200ms = max 10s).
- Bricht ab, sobald der PID-File existiert und der Prozess lebt.

**`src/daemon/runtime.ts`:**
- Neue Methode `getSocketPath()` für Startup-Logging.

## P1 — CLI-Hygiene

### P1.1 — `daemon logs` implementiert

Neue Funktion `daemonLogs()` in `src/daemon/commands.ts`:
- Listet alle `daemon-YYYY-MM-DD.log`-Dateien im `$HARNESS_STATE/logs/`.
- Liest die neueste, gibt die letzten 100 Zeilen aus.
- Graceful handling: fehlendes Verzeichnis, keine Log-Dateien.
- Fehlermeldung von `daemonStart` verweist jetzt auf den echten Log-Pfad.

Neuer Test: `tests/daemon/logs.test.ts` (3 Tests).

### P1.2 — Unbekannte Top-Level-Subcommands abgefangen

`src/index.tsx` prüft vor TUI-Initialisierung:
```typescript
const knownCommands = new Set([undefined, "migrate-home", "daemon", "reload-config"]);
if (!knownCommands.has(process.argv[2])) {
  console.error(`Unknown command: ${process.argv[2] ?? ""}`);
  console.error("Usage: harness [daemon|migrate-home|reload-config]");
  process.exit(1);
}
```

### P1.3 — Init- Parade (implizit gelöst durch P1.2)

Unbekannte Commands fallen nicht mehr in die TUI-Initialisierung. Die
schwere Init (Memory-Service, QMD-Warmup) läuft nur noch für bekannte
Commands — `daemon install` und `daemon status` benötigen kein Memory-Warmup
und laden dieses nicht mehr.

### P1.4 — `prompt("system-prompt")` ohne `inboxPath` gefixt

`src/core/agent.ts` Zeile 208 rief `prompt("system-prompt")` ohne `inboxPath`
als Fallback auf — löste das `[prompts] Missing variable "inboxPath"`-Warning aus.

Fix: `config.systemPrompt ?? ""` — der Default ist leer. Beide Caller
(`runtime.ts`, `App.tsx`) rufen `setSystemPrompt()` mit korrekten Vars auf,
bevor die erste Turn läuft. Der leere Default ist sicher.

## Validierung

### TypeScript

```
npx tsc --noEmit → clean (exit 0)
```

### Tests

```
npx vitest run → 473 passed, 2 failed
```

Die 2 Failures sind pre-existing (wie spezifiziert ignoriert):
- `tests/prompts.test.ts` — System-Prompt-Snapshot veraltet
- `tests/cli/non-tty.test.ts` — dotenv-Output auf stdout

Neue/erweiterte Daemon-Tests: alle 44 grün (6 Test-Files).

### Manuelles Repro-Protokoll

```
Environment:
  HARNESS_HOME=/tmp/harness-repro-home
  HARNESS_STATE=/tmp/harness-repro-state

=== Test: daemon run (foreground, with timeout) ===
[harness-daemon] PID 102485 listening on /tmp/harness-repro-state/daemon.sock
✓ daemon run stays alive (PID 102483)
✓ daemon run was killed by timeout (was blocking correctly)

=== Test: daemon start (with polling) ===
Daemon started (PID 102790).

=== Test: daemon status ===
Daemon Status
──────────────
PID:          102790
Uptime:       0s
Started:      2026-07-11T13:39:55.697Z
Model:        MiniMax-M2.7
Gateways:     none configured
Turns:        0
Sessions:     1
Socket:       /tmp/harness-repro-state/daemon.sock
Last errors:  none

=== Test: daemon logs ===
--- /tmp/harness-repro-state/logs/daemon-2026-07-11.log (last 5 of 5 lines) ---
{...daemon starting...}
{...agent initialized...}
{...session created...}
{...IPC server listening...}
{...daemon started...}

=== Test: daemon stop ===
Daemon stopped (PID 102790).

=== Test: daemon status (after stop) ===
Daemon is not running.

=== Test: unknown subcommand ===
Unknown command: frobnicate
Usage: harness [daemon|migrate-home|reload-config]
Exit code: 1

=== Test: unknown daemon subcommand ===
Unknown daemon subcommand: frobnicate
Usage: harness daemon [start|stop|restart|status|install|run]
Exit code: 1
```

### Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `src/daemon/commands.ts` | `daemonRun()` blockiert forever + Exception-Logging; `daemonStart()` pollt PID-File; neue `daemonLogs()` |
| `src/daemon/runtime.ts` | `getSocketPath()` hinzugefügt |
| `src/core/agent.ts` | `createAgent()` prompt-Fallback → leerer String |
| `src/index.tsx` | `logs` case; unknown-subcommand guard |
| `tests/daemon/logs.test.ts` | Neu: 3 Tests für `daemonLogs` |
