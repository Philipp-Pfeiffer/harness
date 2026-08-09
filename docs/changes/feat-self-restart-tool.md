# Change: Agent-seitiger Selbst-Restart (`request_restart`-Tool)

## Übersicht

Der Agent kann den Deferred Restart jetzt selbst auslösen: das neue Tool
`request_restart` ruft eine vom Daemon injizierte Capability auf, die den
Restart nach Ende des aktuellen Turns plant — derselbe Pfad wie `/restart`
und `/deploy`, inklusive Restart-Marker. `exec` + `systemctl` sind dafür
nicht nötig (wären gefährlich: sie killen den Turn mitten drin und
riskieren den Baileys-Auth-State).

## Symptom / Motivation

- Paket A hat `requestRestartAfterTurn(reason, replyTarget?, gitHead?)` +
  Restart-Marker + Boot-Ping etabliert; `/restart` und `/deploy` nutzen das.
- Der Agent konnte den Deferred Restart aber nicht auslösen: auf Tool-Ebene
  gibt es keine Möglichkeit. Für Config-Änderungen (z. B. neue API-Keys in
  `~/harness/.env`) musste er den User bitten, `/restart` zu schicken.
- `exec` + `systemctl --user restart` ist verboten: killt den Turn mitten
  drin, Baileys-Verbindung bricht hart ab (QR-Neu-Pairing-Risiko).

## Befund / Design

### 1. `request_restart`-Tool (Anforderung 1 + 2)

- Neues Tool in `packages/core/src/tools/requestRestart.ts` (Konvention: ein
  Tool pro Datei, `export const requestRestartTool: Tool`).
- Verdrahtung nach dem `channelFileSender`-Muster (siehe `agent.ts`): der
  Daemon injiziert die Capability als `RunOptions.requestRestart`, die
  Agent-Schleife reicht sie in den `ToolCallContext` durch, das Tool ruft sie
  mit `{ reason }` auf.
- Fehlt die Capability (z. B. TUI-In-Process ohne Daemon), liefert das Tool
  einen sauberen Fehler — kein Fallback auf `systemctl`/`kill`.
- Tool-Beschreibung für das Modell (wörtlich, kurze Variante der
  Aufgabenstellung): "Restart the harness daemon gracefully AFTER the current
  turn completes. Use ONLY after config changes that require a restart (e.g.
  new API keys in ~/harness/.env). Never use systemctl/kill directly. The
  user gets a confirmation message before restart and a 'Back online' ping
  after."
- Parameter: `reason` (Pflicht, kurzer String).
- `conflictKey: "request_restart"` — mehrere parallele Aufrufe in einem Turn
  laufen seriell (kein Doppel-Scheduling-Race innerhalb des Turns).

### 2. FollowUp-Turn statt Statik-Ping bei agent-initiiertem Restart (Anforderung 2b)

- `RestartMarker` um optionales Feld `followUp?: boolean` erweitert. Das
  `request_restart`-Tool setzt `followUp: true`; `/restart` und `/deploy`
  bleiben beim Statik-Ping (`followUp` abwesend/false).
- Boot-Handler (`sendRestartPing` in `selfModify.ts`): bei `followUp: true`
  und gesetztem `replyTarget` wird statt der Statik-Nachricht ein kurzer
  Agent-Turn auf der replyTarget-Session ausgelöst. `DaemonRuntime.
  runRestartFollowUp(sessionId, reason)` nutzt denselben Turn-Pfad wie ein
  eingehender WhatsApp-Turn (Provenienz via `channelAddendum`, Channel-
  File-Sender, Compaction, Metrics) und routet die Antwort über den normalen
  Outbound-Pfad (`plugin.sendMessage` an die Session-Quelle).
- Interner Prompt (`RESTART_FOLLOWUP_PROMPT`): "The daemon just restarted
  (reason: <reason>). Verify briefly that the change took effect (e.g. config
  value loaded, key present) and report back to the user in one or two short
  messages."
- **Fallback:** Schlägt der FollowUp-Turn fehl (wirft), sendet
  `sendRestartPing` trotzdem den Statik-Ping — der Nutzer erfährt auf jeden
  Fall, dass der Daemon wieder da ist. Der Marker wird in beiden Fällen
  gelöscht (konsumiert), kein Retry-Sturm.
- **Loop-Breaker:** Während eines FollowUp-Turns (`postRestartFollowUpActive`
  im Daemon + `postRestartFollowUp`-Flag im `ToolCallContext`/`RunOptions`)
  lehnt `request_restart` mit "restart not allowed during post-restart
  follow-up" ab — kein zweiter Restart, keine Restart-Schleife.

### 3. Guards (Anforderung 4)

- Bereits ein Restart/Deploy anstehend (`pendingRestartReason` gesetzt oder
  `selfModifyInFlight`) → die Capability antwortet
  "restart already scheduled — a restart or deploy is already pending"
  statt doppelt zu schedulen.

## Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `packages/core/src/tools/requestRestart.ts` | **Neu** — `requestRestartTool`, `RequestRestartArgs` |
| `packages/core/src/tools/types.ts` | `ToolCallContext` um `requestRestart` + `postRestartFollowUp` erweitert |
| `packages/core/src/core/agent.ts` | `RunOptions` um `requestRestart` + `postRestartFollowUp` erweitert, Durchreichung in `toolContext` |
| `packages/core/src/tools/registry.ts` | `requestRestartTool` in die Standard-Tool-Liste aufgenommen |
| `packages/core/src/lib.ts` | `requestRestartTool` exportiert |
| `packages/core/tests/tools/requestRestart.test.ts` | **Neu** — 5 Tests |
| `packages/agent/src/daemon/restartMarker.ts` | `RestartMarker.followUp?: boolean` + Round-Trip |
| `packages/agent/src/daemon/selfModify.ts` | `scheduleRestart(reason, replyTarget, gitHead, followUp?)`, `sendRestartPing(..., runFollowUp?)`, `RESTART_FOLLOWUP_PROMPT` |
| `packages/agent/src/daemon/runtime.ts` | `makeRequestRestartCapability(sessionId)`, `runRestartFollowUp`, `postRestartFollowUpActive`, Boot-Handler verdrahtet, Capability im WhatsApp-Turn injiziert, `requestRestartAfterTurn(..., followUp?)` |
| `packages/agent/tests/daemon/restartMarker.test.ts` | +2 Tests (followUp-Round-Trip, Legacy-Marker) |
| `packages/agent/tests/daemon/selfModify.test.ts` | +7 Tests (Capability, already-scheduled, FollowUp-Pfad, Fallback, Legacy, Loop-Breaker) |
| `docs/architecture/self-modification.md` | Runbook: Config-Änderung → `request_restart`-Tool |
| `docs/changes/feat-self-restart-tool.md` | **Neu** — dieser Change-Report |
| `~/harness/skills/self-modification/skill.md` | Skill: `request_restart` statt `/restart` betteln / systemctl |

## Tests

- `requestRestart.test.ts` (core, 5 Tests): ohne Capability → Fehler; mit
  Capability → Deferred Restart mit korrektem reason; Capability-Rejection
  wird durchgereicht; im FollowUp-Turn → Fehler, Capability wird nicht
  aufgerufen.
- `restartMarker.test.ts` (agent): +2 — `followUp: true`-Round-Trip; fehlendes
  Feld bleibt `undefined` (Legacy-Marker kompatibel).
- `selfModify.test.ts` (agent): +7 —
  1. Capability → Marker mit `reason` + `replyTarget` der Session +
     `followUp: true`, kein Sofort-Exit bei laufendem Turn;
  2. Doppelaufruf → "already scheduled", kein zweiter Marker;
  3. `selfModifyInFlight` (Deploy) → "already scheduled";
  4. Boot mit `followUp`-Marker → Agent-Turn auf richtiger Session (Mock),
     Antwort über Channel-Outbound, **kein** Statik-Ping;
  5. FollowUp schlägt fehl → Statik-Ping als Fallback, Marker konsumiert;
  6. Marker ohne `followUp` → Statik-Ping unverändert;
  7. `request_restart` im FollowUp-Turn → Fehler "post-restart follow-up",
     kein zweiter Restart, kein Marker.
- Bestandssuite: siehe Validierung unten.

## Non-Goals

- Kein TUI- oder CLI-Änderung.
- Kein neuer Marker-Mechanismus — nur das bestehende `pending-restart.json`
  mit optionalem Feld.
- Keine Änderung am `/restart`- und `/deploy`-Verhalten (bleiben beim
  Statik-Ping).
