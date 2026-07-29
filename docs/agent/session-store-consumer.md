# Session Store für Fremd-Consumer

`@harness/agent` exportiert einen daemon-unabhängigen Session-Store über
`lib.ts`. Damit kann eine eigenständige App (z.B. ein Lernassistent)
Sessions anlegen, Turns schreiben und später wieder lesen — ohne den
Harness-Daemon zu starten.

## Minimalbeispiel

```js
import { resolveHarnessPaths } from "@harness/core";
import {
  createSession,
  recordTurn,
  readSession,
  listSessions,
  endSession,
} from "@harness/agent";

const paths = resolveHarnessPaths({
  home: "/home/you/harness",     // dein Harness-Home
  state: "/home/you/.lernassistent", // eigener State-Ordner
});

const session = await createSession(paths, {
  model: "minimax-m2.7",
  title: "Study Session",
});

await recordTurn(session, {
  id: crypto.randomUUID(),
  role: "assistant",
  content: "Paris.",
  userContent: "Capital of France?",
  tokens: { input: 10, output: 5, total: 15, cacheRead: 0, cacheWrite: 0 },
  timing: { startedAt: new Date().toISOString(), latencyMs: 100 },
  model: "minimax-m2.7",
  timestamp: new Date().toISOString(),
}, paths);

const loaded = await readSession(session.id, paths);
```

Siehe auch `examples/foreign-consumer/` im Repository für ein vollständiges
Skript mit Write/Read-Modus und Tool-Daten.

## Außerhalb des Workspaces konsumieren

`examples/foreign-consumer/` liegt im pnpm-Workspace und löst `workspace:*`
Dependencies nur deshalb auf. Um die Bibliothek in einer wirklich fremden App
zu verwenden, müssen die Pakete gepackt und über `file:`-Referenzen installiert
werden:

```bash
# Repo-Root
scripts/pack-local.sh
# → erzeugt dist-tarballs/harness-core-*.tgz und dist-tarballs/harness-agent-*.tgz
```

Die gepackte `package.json` von `@harness/agent` enthält dann eine echte
Version für `@harness/core` (z.B. `"0.0.1"`) statt `workspace:*`.

In der Fremd-App:

```json
{
  "dependencies": {
    "@harness/core": "file:/pfad/zu/harness/dist-tarballs/harness-core-0.0.1.tgz",
    "@harness/agent": "file:/pfad/zu/harness/dist-tarballs/harness-agent-0.0.1.tgz"
  }
}
```

Ein vollständiger Durchlauf außerhalb jedes Workspaces wird von
`scripts/verify-foreign-consumer.sh` geprüft: es legt ein temporäres
Verzeichnis an, installiert die Tarballs mit `pnpm install`, schreibt eine
Session in ein eigenes `state`-Verzeichnis und liest sie wieder zurück.

## State-Root explizit setzen

Übergebe `state` immer explizit an `resolveHarnessPaths()`. Damit wird
`$HARNESS_STATE` und `$XDG_STATE_HOME` ignoriert — wichtig, wenn Harness
und die Fremd-App auf demselben Host laufen:

```js
const paths = resolveHarnessPaths({
  home: join(homedir(), "harness"),
  state: join(homedir(), ".lernassistent"),
});
```

## Verfügbare Operationen

| Funktion | Zweck |
|----------|-------|
| `createSession(paths, opts)` | Neue Session + Transkript + Index-Eintrag |
| `recordTurn(session, turn, paths)` | Turn an das Transkript anhängen |
| `readSession(id, paths)` | Session + Turns lesen |
| `loadSession(id, paths)` | Für Resume inkl. Token-Schätzung |
| `listSessions(paths, range?)` | Alle Sessions, optional nach `lastActivity` gefiltert |
| `endSession(session, paths)` | Session beenden (`ended`) |
| `suspendSession(session, paths)` | Session pausieren (`suspended`) |
| `renameSession(session, title, paths)` | Titel ändern (überlebt Index-Neuaufbau) |
| `deleteSession(id, paths, opts?)` | Soft-Delete nach `sessions/deleted/` |

## Boundary-Semantik

- **`active`**: Nur im laufenden Daemon gültig; beim Start werden verwaiste
  `active`-Einträge auf `idle` gesetzt (`markActiveSessionsIdle`).
- **`idle`**: Daemon war abgestürzt, Session ist resumable.
- **`suspended`**: Graceful Shutdown, Session ist resumable.
- **`ended`**: Explizit beendet. Resume wird verweigert.

`listSessions(range)` filtert immer auf `lastActivity`, nicht auf `created`,
damit eine gestern begonnene Session, die heute aktiv war, im "heute"-Filter
erscheint.

## Korruptionsresilienz

Ist `sessions.json` korrupt, wird es als `sessions.json.corrupt-<timestamp>`
gesichert und aus den Transkripten neu aufgebaut. Defekte Einzel-Einträge
werden übersprungen. Ein leerer Index bei einer frischen Installation löst
keinen Vollscan aus.

## Keine Top-Level-Side-Effects

Ein nackter Import des Session-Stores öffnet keine Handles, startet keine
Timer und registriert keine Signal-Handler. Der Prozess beendet sich von
allein. Nachweis im Beispiel:

```bash
cd examples/foreign-consumer
timeout 5 node check-side-effects.mjs
```
