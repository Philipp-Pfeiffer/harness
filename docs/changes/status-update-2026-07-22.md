# Harness WhatsApp Gateway — Status Update (2026-07-22)

## Übersicht

WhatsApp Gateway v1 und v1.1 sind implementiert und auf `main` gemergt.
Derzeit ist der Daemon nach einer Reihe von Restart-/Auth-Problemen gestoppt
und benötigt einen finalen QR-Scan, um wieder einsatzbereit zu sein.

## Was funktioniert (Code-Ebene)

- **Channel-Plugin-Architektur**: WhatsApp ist als erstes `ChannelPlugin`
  registriert; weitere Channels können später analog hinzugefügt werden.
- **Baileys-Client**: Pairing-Code/QR-Auth, Session-Persistence unter
  `$HARNESS_STATE/whatsapp/auth`, Reconnect mit Backoff.
- **Inbound-Verarbeitung**:
  - Text → Agent-Turn.
  - Media (Bilder, PDFs, ZIPs, Audio, Video) → Download nach
    `$HARNESS_STATE/inbound-media/`, Datei-Annotation an den Turn.
  - Bilder → Image-Content-Block, wenn das Modell Vision unterstützt.
  - Voice-Nachrichten (`ptt:true` / `audio/ogg`) → AssemblyAI-Transkription,
    Transkript als Text im Turn.
  - Sticker → nur loggen + speichern, kein Turn.
- **Outbound-Verarbeitung**:
  - Agent-Antworten werden durch die Channel-Output-Pipeline gerendert.
  - Tabellen/Code werden via `satori`→`resvg` als PNG gerendert und als
    Bild-Message gesendet.
  - `send_file`-Tool erlaubt dem Agenten, Dateien in den Chat zu schicken.
- **Session-Handling**: Persistente Session pro Chat, 8h-Inactivity-Compaction
  vor dem Turn.
- **Test-Mode**: `harness whatsapp --test` (bzw. Daemon-Flag) zum Testen ohne
  Agent-Turns.

## Aktuelle Konfiguration

- **Linked-Device-Nummer** (`daemon.whatsapp.phoneNumber` in
  `~/harness/config.json`): `4915170284381`
- **Whitelist-Absender** (`WHATSAPP_WHITELIST_NUMBER` in `~/.harness_env`):
  `4915110619636`
- **AssemblyAI**: `ASSEMBLYAI_API_KEY` in `~/.harness_env`
- **OpenRouter**: `OPENROUTER_API_KEY` und `OPENROUTER_IMAGE_API_KEY` in
  `~/.harness_env`
- **Env-Datei**: `~/.harness_env` wird von `~/.bashrc` und
  `scripts/restart-daemon.sh` geladen.

## Was in dieser Session gefixt wurde

1. **Race-free Daemon-Restart** (`scripts/restart-daemon.sh`,
   `packages/agent/src/daemon/commands.ts`)
   - `flock`-Lock verhindert parallele Restarts.
   - `pgrep`-basiertes Warten garantiert, dass der alte Prozess weg ist,
     bevor der neue startet.
   - `daemonRestart()` wartet bis zu 20 s auf Prozessende.

2. **Env-Loading-Fix** (`~/.harness_env`, `scripts/restart-daemon.sh`,
   `~/.bashrc`)
   - Ursache für „Nachrichten kommen an, aber nichts passiert": `.bashrc`
     bricht in nicht-interaktiven Shells ab, daher wurden
     `WHATSAPP_WHITELIST_NUMBER` und `ASSEMBLYAI_API_KEY` nicht geladen.
   - Fix: Dedizierte `~/.harness_env`, die sowohl von `.bashrc` als auch vom
     Restart-Skript geladen wird.

## Aktueller Status (Live)

- **Daemon**: Gestoppt (kein `node packages/agent/dist/index.js daemon run`
  mehr aktiv).
- **Auth-State**: Zurückgesetzt (`$HARNESS_STATE/whatsapp/auth` leer).
- **Letzter QR-Code**: `~/Downloads/whatsapp-qr.png` (22:44 Uhr), aktuell
  ungescannt.
- **Voraussetzung für Betrieb**: Daemon starten + QR-Code mit dem Handy
  `4915170284381` scannen.

## Bekannte offene Punkte

- **Schreibensymbol / „Agent denkt"-Feedback**: Noch nicht implementiert.
- **Fehlermeldung statt Schweigen bei Turn-Fehlern/Timeouts**: Teilweise
  vorhanden (`[Fehler] Agent-Turn fehlgeschlagen`), aber kein Timeout-Guard.
- **Weißer Rand in Tabellen-Bildern**: Noch nicht gefixt.
- **Sticker-Verhalten**: Sticker werden gespeichert, lösen aber keinen Turn
  aus und bekommen keine Reaktion.
- **Nachrichten als gelesen markieren**: Implementiert (`markAsRead` direkt
  nach Inbound), muss live noch verifiziert werden.
- **OpenClaw parallel auf derselben Nummer**: Nicht getestet.

## Nächste Schritte

1. Daemon starten:
   ```bash
   cd /home/p-pfeiffer/dev/harness
   ./scripts/restart-daemon.sh
   ```
2. Aktuellen QR-Code aus `~/Downloads/whatsapp-qr.png` mit Handy
   `4915170284381` scannen.
3. Von `4915110619636` eine Testnachricht schicken.
4. Wenn Nachrichten ankommen und beantwortet werden: offene UX-Punkte
   (Schreibensymbol, Fehlerfeedback, weißer Rand) angehen.

## Wichtige Dateien

- `scripts/restart-daemon.sh`
- `packages/agent/src/daemon/commands.ts`
- `packages/agent/src/whatsapp/plugin.ts`
- `packages/agent/src/whatsapp/client.ts`
- `packages/agent/src/whatsapp/inbound.ts`
- `packages/agent/src/whatsapp/outbound.ts`
- `docs/changes/daemon-restart-race-fix.md`
- `docs/changes/whatsapp-env-loading-postmortem.md`
