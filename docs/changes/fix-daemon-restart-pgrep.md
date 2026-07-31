# fix: daemon restart false timeout

## Problem

`harness daemon restart` often failed with:

```
Daemon restart failed: old daemon process did not exit in time.
```

even though the daemon had already stopped.

## Befund

`waitUntilNoDaemonProcess` used `exec('pgrep -f '<entry> daemon run'')` via a shell.
The shell command line contained the same `daemon run` substring, so `pgrep` matched
the shell/pgrep process itself on every poll. The wait loop never succeeded.

## Fix

- `findDaemonRunPids()` uses `execFile('pgrep', ['-f', pattern])` without a shell
- Pattern uses the `[d]aemon run` bracket trick so pgrep does not match its own argv
- `daemonStop()` requests IPC shutdown first, then SIGTERM/SIGKILL, then kills stragglers
- `daemonRestart()` force-kills any remaining PIDs before failing
- `scripts/restart-daemon.sh` uses the same bracket pattern

## Files

- `packages/agent/src/daemon/process.ts`
- `packages/agent/src/daemon/commands.ts`
- `scripts/restart-daemon.sh`
- `packages/agent/tests/daemon/processDiscovery.test.ts`
