# fix(restart/deploy): Sofortiges User-Feedback vor Restart und Deploy

## Problem/Symptom
- Wenn der Agent `request_restart` nutzt, bekommt der User erst nach dem Neustart eine Rückmeldung ("Back online"-Ping) — **vorher** passiert mehrere Sekunden lang nichts.
- `/deploy` liefert erst nach Abschluss des Build-/Test-/Restart-Prozesses eine Nachricht — der User weiß nicht, ob der Befehl angekommen ist.

## Befund
- `requestRestartAfterTurn` schrieb zuerst den Restart-Marker und sendete erst später (bzw. nach dem Restart) die Bestätigung. Der Marker wurde geschrieben, bevor irgendeine Nachricht den Channel erreichte.
- Der Deploy-Handler rief `runDeploy` (bzw. `safe-deploy.sh`) direkt auf, ohne vorher eine Bestätigung an den Channel zu senden.
- Der progressive Send-Mechanismus erlaubt es, Nachrichten während eines Turns sofort (flush) an den Channel zu senden — dieser wurde nicht genutzt.

## Was geändert wurde

### `packages/agent/src/daemon/runtime.ts`
- `requestRestartAfterTurn` hat einen neuen Parameter `announceBeforeRestart?: () => Promise<void>`.
  - Die Announcement-Callback wird **vor dem Schreiben des Restart-Markers** awaited; Fehler werden geloggt, blockieren aber den Restart nicht.
  - JSDoc entsprechend aktualisiert.
- `makeRequestRestartCapability` übergibt als `announceBeforeRestart` einen `sendChannelResponse`-Aufruf:
  - `"Restart eingeleitet — bin in ~20 Sekunden zurück."`
  - Wird gesendet, bevor der Marker geschrieben wird — der User bekommt sofort Feedback, auch wenn noch ein Turn aktiv ist.
- Deploy-Handler (`handleDeployCommand`): direkt **vor** dem `runDeploy`-Aufruf wird per `sendChannelResponse` gesendet:
  - `"Deploy <branch> angestoßen — bauen, testen, restarten..."`
  - Das ACK ist awaited, damit es tatsächlich flushed, bevor das Skript startet.

### `packages/agent/tests/daemon/selfModify.test.ts`
- Test `request_restart tool capability (daemon side) / schedules a deferred restart...`: mockt jetzt den WhatsApp-Plugin-Send und verifiziert, dass die Nachricht mit `"Restart eingeleitet"` synchron vor dem Marker-Schreiben gesendet wird.
- Test `no turn: pre-restart confirmation send completes before the shutdown signal`: `sendMock` verwaltet eine Promise-Queue (Deploy-ACK + Restart-Confirmation werden sequenziell freigegeben), sodass der Test das neue Zwei-Nachrichten-Verhalten korrekt abbildet.

## Dateien
- `packages/agent/src/daemon/runtime.ts`
- `packages/agent/tests/daemon/selfModify.test.ts`
- `docs/changes/fix-restart-deploy-feedback.md`

## Tests
- `pnpm build` grün.
- `pnpm typecheck` grün.
- `pnpm --filter @harness/agent test -- daemon/selfModify` grün (alle Tests).
- `pnpm --filter @harness/agent test`: 47 Files / 497 Tests grün.
- Pre-existing Failure (auch auf `main`, nicht durch diesen Change verursacht): `packages/core/tests/tools/exec.test.ts` → `id -u with elevated → 0 (if passwordless sudo)` (kein passwordless sudo in der Umgebung).
