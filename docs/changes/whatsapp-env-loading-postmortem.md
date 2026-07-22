# Postmortem: WhatsApp-Env-Variablen nicht geladen

## Symptom

Nach dem Race-Fix für den Daemon-Restart wurde WhatsApp zwar verbunden,
aber eingehende Nachrichten wurden weder gelesen markiert noch beantwortet.
Voice-Nachrichten wurden als reine Media-Dateien behandelt statt transkribiert.
Der Verdacht lag auf einem erneuten Auth-State-Problem; tatsächlich war die
Ursache aber ein komplett anderer Fehler.

## Root Cause

`scripts/restart-daemon.sh` lud die benötigten Umgebungsvariablen durch
`source "$HOME/.bashrc"`. Die `.bashrc` auf diesem System beginnt jedoch mit:

```bash
[[ $- != *i* ]] && return
```

Das bewirkt, dass die Shell-Initialisierungsdatei in **nicht-interaktiven**
Shells sofort verlassen wird. Das Restart-Skript läuft nicht-interaktiv,
darum wurden die hinter dem Return stehenden Exports nie ausgeführt.

Konkret fehlten im Daemon-Prozess:

- `WHATSAPP_WHITELIST_NUMBER`
- `ASSEMBLYAI_API_KEY`

Folgen:

1. **Whitelist leer**: `isWhitelisted()` in `packages/agent/src/whatsapp/whitelist.ts`
   returned `false` für jede Absendernummer. Jede eingehende Nachricht wurde
   als „non-whitelisted message" still verworfen.
2. **Keine Voice-Transkription**: Ohne `ASSEMBLYAI_API_KEY` konnte keine
   Transkription durchgeführt werden.

Der Daemon zeigte also scheinbar ein Auth-Problem (später `disconnect reason 401`
und erneuter QR-Code), weil der Auth-State durch die vielen Restarts und den
Nummerntausch zusätzlich invalidiert wurde. Die unmittelbare Ursache für
„Nachricht kommt an, aber nichts passiert" war aber die fehlende Whitelist.

## Fix

1. **Dedizierte Env-Datei**: Alle Harness-relevanten Env-Variablen wurden in
   `~/.harness_env` ausgelagert. Diese Datei enthält nur Exports und keinen
   frühen Return.

2. **`.bashrc` angepasst**: Statt die Variablen direkt zu definieren, sourced
   `.bashrc` jetzt `~/.harness_env`.

3. **`scripts/restart-daemon.sh` angepasst**: Das Skript sourced jetzt direkt
   `~/.harness_env` statt `.bashrc`. Das ist robust gegen frühe Returns oder
   interaktive Prompts in `.bashrc`.

## Warum das nicht früher auffiel

- Der vorherige manuelle Start des Daemons erfolgte über einen Hintergrund-Task,
  der die Env-Variablen explizit exportiert hatte. Dort waren sie vorhanden.
- Beim späteren Restart über das Skript wurden sie nicht mehr gesetzt, aber die
  Folge sah aus wie ein Auth-Problem — also wurde am Auth-State gearbeitet
  statt an der Konfiguration.

## Lessons Learned

- `.bashrc` ist keine zuverlässige Quelle für Daemon-Env-Variablen.
- Wenn ein Skript Env-Variablen braucht, immer eine dedizierte, nicht-
  interaktive Datei verwenden.
- Bevor ein Problem als Auth-State interpretiert wird, prüfen:
  1. Laufen die richtigen Prozesse (kein Race)?
  2. Sind die benötigten Env-Variablen im Prozess wirklich gesetzt
     (`/proc/<pid>/environ`)?
  3. Erst dann Auth-State zurücksetzen.

## Betroffene Dateien

- `~/.harness_env` (neu)
- `~/.bashrc` (außerhalb des Repos, verweist jetzt auf `~/.harness_env`)
- `scripts/restart-daemon.sh` (lädt jetzt `~/.harness_env`)

## Status

Env-Problem behoben. Der Daemon läuft mit korrekten Variablen. Wegen der
vielen vorangegangenen Restarts und dem Nummerntausch ist der Baileys-Auth-State
aktuell ungültig (401); ein letzter QR-Scan ist nötig, um WhatsApp wieder als
Linked Device zu verbinden.
