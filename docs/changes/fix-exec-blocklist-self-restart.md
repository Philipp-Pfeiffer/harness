# Change: exec-Blocklist gegen Daemon-Selbstmord (fix-exec-blocklist-self-restart)

## Problem / Symptom

`EXEC_NO_FLY_PATTERNS` in `packages/core/src/tools/path_util.ts` blockte keine
Daemon-Selbstmord-Befehle. Der Agent konnte den Daemon aus einem exec heraus
stoppen, z. B. mit

```
nohup bash -c 'sleep 20 && systemctl --user restart harness-daemon.service' >/tmp/x 2>&1 & disown
```

Der Turn wird mitten drin gekillt, die Baileys-Verbindung bricht hart ab
(QR-Neu-Pairing-Risiko). Es gibt dafür das `request_restart`-Tool, das den
Restart graceful nach Ende des Turns plant.

## Befund

Beim Testen der neuen Patterns fiel zudem ein pre-existing Bug auf:
`executeExec` in `packages/core/src/tools/exec.ts` war `async`, gab die
Unter-Funktionen aber ohne `await` zurück. Das äußere Promise löste das innere
Promise nicht ab — Aufrufer erhielten `{}`/`undefined` statt des
`ToolResult`. Bestehende Tests fielen nicht auf, weil der Bug von einem
veralteten Zwischenstand maskiert wurde; in der Suite hier zeigten die neuen
exec-Blocklist-Tests `expected undefined to be true`.

## Geändert

### 1. `packages/core/src/tools/path_util.ts` — 3 neue No-Fly-Patterns

| Pattern | Erfasst |
|---------|---------|
| `systemctl(\s+--user)?\s+(restart\|stop\|kill)\s+["']?harness-daemon(\.[a-z]+)?["']?(\s\|$)` | `systemctl --user restart/stop/kill harness-daemon(.service)`, auch ohne `--user` (System-Ebene) |
| `(?:^|\s|\||;|&&)(?:kill\|pkill\|killall)(?:\s+-[a-zA-Z0-9]+)*(?:\s+\(?\s*(?:\$(\|`))?\s*["']?[^"'\s]*harness[^"'\s]*["']?` | `kill $(pgrep ... harness ...)`, `pkill -f harness`, `pkill -f 'harness daemon'`, `killall harness(-daemon)` |
| `\b(?:pkill\|pgrep\|killall)\b(?=[^|;&]*harness)` | alle `pkill`/`pgrep`/`killall`-Befehle mit `harness` im Rest der Pipe/des Semikolon-Blocks (z. B. `pgrep` mit vorgeschaltetem `kill`) |

Alle drei mit Hint: „Use the request_restart tool instead — it restarts the
daemon gracefully after the current turn."

Die Patterns greifen egal wie verschachtelt (`nohup`, `bash -c`, `sleep`-Ketten,
`disown`), weil die Regex ohne Awareness der Shell-Nesting-Ebenen auf den
gesamten Command-String matchen.

### 2. `packages/core/src/tools/exec.ts`

- `await` bei allen `return`-Zweigen von `executeExec` ergänzt
  (`executeExecBackground`, `executeExecPty`, `executeExecSyncWithYield`,
  `executeExecSync`).
- Tool-Description ergänzt: „Daemon restarts run exclusively through the
  request_restart tool — never restart the harness daemon via systemctl or
  kill."

### 3. `packages/core/tests/tools/exec.test.ts` — Tests

- Neue Describe-Blöcke:
  - **Blocklist-Fälle (17):** die exakten wörtlichen Incident-Befehle
    (`nohup bash -c 'sleep 20 && systemctl --user restart harness-daemon.service' >/tmp/x 2>&1 & disown`
    und Varianten mit `stop`/`kill`, system- und user-scope,
    `kill $(pgrep …)`, `pkill -f …`, `killall`), jeweils mit Assertion auf
    `Blocked destructive command` und `request_restart`-Hint.
  - **False-Positives (11):** `systemctl --user status harness-daemon`,
    `systemctl status sshd`, `systemctl list-units`, `systemctl list-unit-files`,
    `systemctl --user daemon-reload`, `ps aux | grep harness`, `echo harness`,
    `pkill -f sshd`, `killall sshd`, `kill 12345` — alle erlaubt.

## Tests

- `pnpm build` grün
- `pnpm typecheck` grün
- `pnpm -r test`: 539 Tests in `packages/core` (nur der pre-existing
  sudo-Flake in `exec.test.ts` rot — System meldet „Ein Passwort ist
  notwendig" statt „a password is required", reproduzierbar auch auf `main`),
  `packages/agent`: 465 Tests grün
