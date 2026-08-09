# Change: Restart-Ping wartet auf WhatsApp-Connection-Ready

## Übersicht

Der Boot-Ping nach einem Daemon-Restart feuert zu früh: `sendRestartPing`
lief ~5s nach Prozessstart, während die Baileys-Verbindung noch nicht offen
war. Der Send schlug mit "Connection Closed" fehl, der Marker wurde trotzdem
konsumiert — der Nutzer bekam nie eine Nachricht. Dieser Change lässt den
Ping (Statik **und** FollowUp-Turn) warten, bis der WhatsApp-Kanal
tatsächlich verbunden ist, und sichert zusätzlich ab, dass die
Pre-Restart-Bestätigung vor dem Shutdown rausgeht.

## Symptom / Motivation

- Live-Deploy am 09.08., daemon-Log 11:19:27: Boot-Ping schlägt mit
  "Connection Closed" fehl, weil `sendRestartPing` ~5s nach Prozessstart
  läuft, die Baileys-Verbindung zu dem Zeitpunkt aber noch nicht steht.
- Der Marker wird trotzdem konsumiert → der Nutzer bekommt nie eine
  Nachricht (weder "Deploy prepared, restarting…" noch "Back online").
- Dieselbe Pre-Restart-Bestätigung ("Deploy prepared, restarting…" bzw.
  `/restart`-Bestätigung) kam im Live-Deploy nicht an.

## Befund / Design

### 1. Gemeinsame Warte-Funktion `waitForChannelReady` (Anforderung 1)

- Neue Datei `packages/agent/src/daemon/restartPing.ts`:
  `waitForChannelReady(plugin, log, timeoutMs = 60s, pollMs = 500ms)`.
- Die Funktion pollt `plugin.healthCheck()` — der WhatsApp-Plugin
  delegiert das an `client.isConnected()` (Baileys `connection.update`
  mit `connection === "open"`, siehe `client.ts`). Polling statt
  einmaliger Event-Subscription: Baileys kann zwischen Verbindungs-
  versuchen `close`-Events liefern, und eine Event-Subscription hätte
  Races, wenn das `open`-Event vor der Registrierung feuert.
- Bei sofortiger Verbindung resolved die Funktion ohne Verzögerung;
  sonst pollt sie bis zum Deadline und wirft einen beschreibenden Fehler.
- Konstanten `RESTART_WAIT_TIMEOUT_MS = 60_000` und
  `RESTART_WAIT_POLL_MS = 500` sind exportiert (Tests kürzen sie ab).

### 2. `sendRestartPing` wartet VOR Statik-Ping UND FollowUp-Turn

- `sendRestartPing(marker, sendMessage, log, runFollowUp?, waitForReady?)`
  bekommt einen optionalen `waitForReady`-Callback (5. Parameter).
- `waitForReady` wird **vor** dem Statik-Ping und **vor** dem
  FollowUp-Turn awaited — dieselbe Warte-Logik für beide Pfade, wie
  gefordert. Der Daemon injiziert im Boot-Handler den
  `waitForChannelReady`-Callback (Anforderung: "Gilt für Statik-Ping UND
  FollowUp-Turn — gemeinsame Funktion").
- Bei endgültigem Fehlschlag (Timeout erschöpft): warn-Log
  ("restart ping skipped — WhatsApp not connected … marker consumed"),
  kein Send, Marker bleibt konsumiert (aktuelles Verhalten beibehalten).
  Kein Retry-Sturm über Boots hinweg, da der Marker bereits weg ist.

### 3. Pre-Restart-Bestätigung vor Shutdown (Anforderung 3)

- Beleg im Code: Bei `turnActive === false` plante
  `requestRestartAfterTurn` den Shutdown per `setImmediate`, während
  `inbound.ts:124` die Bestätigung erst **nach** `executeCommand` über
  `sendOutbound` sendet (fire-and-forget bis dahin). Der
  `setImmediate`-Shutdown konnte den Baileys-Send-Flush unterbrechen.
- Fix: `requestRestartAfterTurn(..., awaitBeforeRestart?)` — ein
  optionaler Callback, der **vor** dem `setImmediate`-Shutdown awaited
  wird. `/restart` und `/deploy` übergeben dort `sendChannelResponse`:
  sie senden die Bestätigung via `plugin.sendMessage` mit `await`.
- `sendChannelResponse(sessionId, text)` ist eine neue private Methode:
  löst die Session-Quelle auf, sendet über den WhatsApp-Plugin, loggt
  Erfolg/Fehler. Fehlt Session/Plugin, wird nichts gesendet — der
  Restart läuft trotzdem (Best-Effort).
- Die Handler geben in diesem Fall `{ response: "" }` zurück — der
  normale Outbound-Pfad in `inbound.ts` rendert leeren Text nicht
  (`outbound.ts` überspringt `if (msg.text.trim())`), also kein
  Doppel-Send.

## Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `packages/agent/src/daemon/restartPing.ts` | **Neu** — `waitForChannelReady`, `RESTART_WAIT_TIMEOUT_MS`, `RESTART_WAIT_POLL_MS` |
| `packages/agent/src/daemon/selfModify.ts` | `sendRestartPing(..., waitForReady?)` — wartet vor Statik-Ping UND FollowUp |
| `packages/agent/src/daemon/runtime.ts` | Boot-Handler: `waitForChannelReady` injiziert; `requestRestartAfterTurn(..., awaitBeforeRestart?)`; `/restart` + `/deploy`: Bestätigung via `sendChannelResponse` vor Shutdown |
| `packages/agent/tests/daemon/restartPing.test.ts` | **Neu** — 7 Tests |
| `packages/agent/tests/daemon/selfModify.test.ts` | +2 Tests (Deploy-Bestätigung vor Shutdown; Pre-Restart-Send abgeschlossen bevor Shutdown-Signal), 2 Tests angepasst |
| `docs/changes/fix-restart-ping-connection-ready.md` | **Neu** — dieser Change-Report |

## Tests

- `restartPing.test.ts` (agent, neu, 7 Tests):
  1. `waitForChannelReady` resolved sofort, wenn schon verbunden;
  2. pollt bis die Verbindung offen ist (2× false, dann true);
  3. rejected nach Deadline, wenn nie verbunden;
  4. **Ping wartet auf Connection-Ready:** Verbindung 2× nicht bereit
     (send würde fehlschlagen), dann offen → Nutzer bekommt "Back online";
  5. **Timeout:** kein Send, warn-Log mit "marker consumed";
  6. Warte-Funktion greift auch vor dem FollowUp-Turn;
  7. ohne `waitForReady` unverändertes Verhalten.
- `selfModify.test.ts` (agent, angepasst/neu):
  - Deploy-Erfolg ohne laufenden Turn: Bestätigung "Deploy prepared,
    restarting…" geht **vor** dem Shutdown über den Channel, Response-Slot
    leer, Shutdown mit exit 1.
  - **Pre-Restart-Antwort wird vor Shutdown-Signal abgeschlossen:** der
    Send bleibt pending, bis er explizit released wird — der Shutdown ist
    bis dahin nicht geplant; erst nach dem Release läuft
    `shutdownWithExit("self-restart", 1)`.
  - `/restart` ohne Turn: Response leer (Bestätigung via Channel).
- Bestandssuite: 446 Tests bleiben grün (454 gesamt, +8 neu).

## Validierung

- `pnpm build` — grün.
- `pnpm typecheck` — grün.
- `pnpm --filter @harness/agent test` — 43 Files / 454 Tests grün.
- Kein echter Restart während der Validierung.

## Non-Goals

- Kein Retry-Loop mit mehreren Send-Versuchen des Pings selbst — die
  Warte-Logik ersetzt das: Der Ping wird erst gesendet, wenn der Kanal
  bereit ist; danach schlägt der Send nur noch bei echten Transport-
  Fehlern fehl (dann warn + Marker konsumiert, wie bisher).
- Keine Änderung am Boot-Verhalten ohne Marker, keine Änderung an
  `restartMarker.ts` (Marker-Logik bleibt unverändert).
