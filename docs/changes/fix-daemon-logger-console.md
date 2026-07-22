# fix: Daemon-Code verwendet konsistente Ausgabe statt rohem console.log

## Problem

Der Daemon-Code in `packages/agent/src/daemon/commands.ts` enthielt drei
`console.log`-Aufrufe in der `harnessChat`-Funktion. Diese sind inkonsistent
mit dem restlichen Code der Funktion, der durchgängig `process.stdout.write`
verwendet. Zudem verstößt rohes `console.log` gegen die Konvention, dass
Daemon-Code den strukturierten DaemonLogger bzw. einheitliche
Ausgabe-Methoden nutzen soll.

## Befund

Grep nach `console.*` in `packages/agent/src/daemon/`:

```
commands.ts:447  console.log(`Session: ${activeSessionId}`);
commands.ts:466  console.log(`Resumed session: ${activeSessionId} (${resp.messageCount} messages)`);
commands.ts:478  console.log(`Type your message. Ctrl+C to exit.\n`);
```

Diese drei Aufrufe befinden sich in `harnessChat` — einer interaktiven
CLI-Client-Funktion. In dieser Funktion ist kein DaemonLogger verfügbar
(es ist Client-Code, der mit dem Daemon via IPC kommuniziert). Die gesamte
Funktion verwendet `process.stdout.write` für Terminal-Ausgaben, weshalb
die `console.log`-Aufrufe als Inkonsistenz auffallen.

Die `process.stderr.write`-Aufrufe in `daemonRun` sind bewusst: sie
erzeugen User-facing-Startmeldungen im Foreground-Modus (`daemon run`),
die bei `stdio: "ignore"` (detached via `daemon start`) unterdrückt werden.
Die `DaemonRuntime` logt intern bereits über ihren `DaemonLogger`.

## Änderung

**Datei:** `packages/agent/src/daemon/commands.ts`

Die drei `console.log`-Aufrufe wurden durch `process.stdout.write` ersetzt,
um Konsistenz mit dem restlichen `harnessChat`-Code herzustellen:

```diff
- console.log(`Session: ${activeSessionId}`);
+ process.stdout.write(`Session: ${activeSessionId}\n`);
```

```diff
- console.log(`Resumed session: ${activeSessionId} (${resp.messageCount} messages)`);
+ process.stdout.write(`Resumed session: ${activeSessionId} (${resp.messageCount} messages)\n`);
```

```diff
- console.log(`Type your message. Ctrl+C to exit.\n`);
+ process.stdout.write(`Type your message. Ctrl+C to exit.\n\n`);
```

(Hinweis: `console.log` hängt automatisch ein `\n` an — bei `process.stdout.write`
muss dies explizit sein. Der dritte Aufruf hatte `\n` im String plus ein
implizites `\n` durch `console.log`, daher wird `\n\n` für identisches
Verhalten benötigt.)

## Tests

`npx vitest run` — alle 677 Tests in 56 Files grün.
