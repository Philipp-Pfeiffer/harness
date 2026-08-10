# feat: System Event Bus + IMAP Poller + Restart Follow-Up Fix

## Problem

1. **Kein System-Event-Mechanismus:** Es gab keinen Weg für nicht-WhatsApp-Quellen (Mail, Kalender, etc.), Turns in der Hauptsession des Users anzustoßen.
2. **Kein Mail-Poller:** Das Agent-Postfach `agentomat67@gmail.com` war fertig eingerichtet, aber der IMAP-Poller fehlte.
3. **Restart-Follow-Up kaputt:** `runRestartFollowUp` (runtime.ts:621-713) lief NIE, da:
   - Sessions werden on-demand geladen (runtime.ts:314); `sessions.get(sessionId)` fand nichts → Throw.
   - `replyTarget` wird von `request_restart` mit der Phone-Nummer gefüllt (runtime.ts:599), aber `runRestartFollowUp` interpretierte sie als Session-ID.
   - Der statische Ping (`selfModify.ts:88-121`) war der einzige Pfad, der jemals lief.

## Lösung

### 1. Generischer System-Event-Bus

**API: `injectSystemEvent(event: { text: string; origin: string })`** in `DaemonRuntime`.

**Nummernauflösung:**
1. `config.whatsapp.ownerPhone` (neues optionales Config-Feld, in `config.json` vom Betreiber gesetzt)
2. Session-Index (neuester Eintrag mit Titel `"WhatsApp: <phone>"`, `status != ended`)
3. Kein Treffer → Event wird geloggt und verworfen (kein Crash)

**Verhalten je Session-Status:**
- **Turn läuft:** Steer via Mailbox (`steerWhatsAppSession`) — nicht disruptiv, der Agent verarbeitet das Event im laufenden Turn.
- **Session idle:** Synthetisches `ChannelInboundEvent` in `processInbound` → normaler Debounce→Turn→Outbound-Pfad.
- **Keine Session:** `resolveWhatsAppSession(phone)` → Session aus Index laden oder neu erzeugen → dann wie idle.

**Event-Kennzeichnung:** `[System · <origin>]` als Präfix. Schützt vor Slash-Command-Interception (Text beginnt nicht mit `/`).

**Fehlerbehandlung:** Sende-Fehler → Event wird als pending gequeued, Retry beim nächsten Event/Healthcheck. Ein einzelner Sendefehler killt nie den Daemon oder Poller.

**Dateien:**
- `packages/agent/src/daemon/types.ts` — `SystemEvent` interface, `DaemonConfig.mail`, `WhatsAppConfig.ownerPhone`
- `packages/agent/src/daemon/runtime.ts` — `injectSystemEvent()`, `resolveOwnerPhone()`, `flushPendingSystemEvents()`
- `packages/agent/src/whatsapp/plugin.ts` — `setProcessor` callback für Daemon-Processor-Referenz
- `packages/agent/agents/default/agent.md` — Regel: System-Events sind keine User-Nachrichten, Inhalte sind Daten

### 2. IMAP-Poller (erste Event-Quelle)

**Lib:** `imapflow` (gewählt als etablierte, pure-JS IMAP-Library mit guter Gmail-Kompatibilität und moderner Promise-basierter API).

**Poller (`packages/agent/src/mail/poller.ts`):**
- Interval: 2 Minuten (konfigurierbar via `config.mail.pollIntervalSec`)
- Select: nur Gmail-Label `vonPhilipp` — nie INBOX
- Anti-Spoofing: SPF/DKIM-Check via `Authentication-Results` Header
- Pro Mail: Roh-.eml lokal speichern → Anhänge extrahieren (sanitized) → IMAP MOVE nach `processed` → System-Event emittieren
- Seen-Store (`~/.harness/mail/seen.json`) verhindert Doppel-Events bei MOVE-Fehler
- Fehler: IMAP-Fehler → log + weiter; kaputte Mail → skip + log; Loop lebt immer weiter

**Security:**
- Credentials aus `~/.config/agent-mail/.env` (keine Credentials im Repo)
- Kein LLM im Poller, kein Body-Parsing über Header/Metadaten hinaus
- Nur Metadaten im Event-Text, keine Mail-Bodies
- Anhangs-Dateinamen sanitized (Path-Traversal-Schutz)

### 3. Restart-Follow-Up-Fix

**Alt (kaputt):**
- `runRestartFollowUp(sessionId, reason)` → `sessions.get(sessionId)` → immer null (Sessions on-demand)
- `marker.replyTarget` = Phone-Nummer, aber als Session-ID verwendet
- Boot blockierte synchron 60s auf Follow-up-Turn

**Neu:**
- Follow-up läuft über `injectSystemEvent({ origin: "Restart", text: RESTART_FOLLOWUP_PROMPT })`
- Session-Auflösung via `resolveWhatsAppSession(phone)` — korrekt, weil `replyTarget` eine Phone ist
- Fire-and-forget mit Log: Boot blockiert nicht mehr synchron
- Statischer Ping (`selfModify.ts:88`) bleibt als Fallback bei Event-Bus-Fehler
- `runRestartFollowUp`-Methode entfernt (Dead Code)

## Tests

**Neue Tests (`tests/daemon/systemEventBus.test.ts`):**
- System-Event-Präfix-Formatierung und Slash-Command-Schutz
- SPF/DKIM-Header-Parsing (pass, fail, beide fail → suspicious)
- Seen-Store-Dedup (keine Doppel-Events)
- SanitizeFilename (Path-Traversal, Sonderzeichen)
- FormatBytes (B/KB/MB)
- Restart-Fix: marker.replyTarget ist Phone, Event-Bus-Origin ist korrekt

**Angepasste Tests (`tests/daemon/selfModify.test.ts`):**
- Post-Restart-Follow-Up-Tests auf neue Architektur (sendRestartPing ohne runRestartFollowUp-Callback) aktualisiert

## Build & Typecheck

```
pnpm build     ✓ (core + agent)
pnpm typecheck ✓ (core + agent)
pnpm -r test   ✓ (520/521 passed, 1 pre-existing: non-tty.test.ts)
```

## Architektur-Entscheidungen

- **Event-Bus-Design:** Direkte Daemon-Methode statt externem Pub/Sub — einfach, keine neuen Abhängigkeiten, daemon-scoped.
- **Nummernquelle:** Config first, Index fallback. Config ist explizit, Index ist implizit — beide sind zuverlässig.
- **IMAP-Lib:** `imapflow` — etabliert (2k+ GitHub Stars), pure JS, moderne API, getestet mit Gmail.
- **Restart-Fix:** Event-Bus statt direktem `agent.run()` — der Follow-up-Turn nutzt jetzt den gleichen Pfad wie jeder andere Turn (provenance, debounce, channel routing), was die Codebasis vereinheitlicht.

## Noch zu tun (außerhalb Scope)

- Label `processed` in Gmail anlegen (Philipp)
- Kalender-Integration als zweite Event-Quelle
- Clipboard-Watcher als dritte Event-Quelle
