# Self-Modification Runbook

**Stand:** 2026-08-08 · **Host:** `assistomat` · **Scope:** sicheres Selbst-Deployen und Selbst-Neustarten des Harness-Agenten

---

## Topologie

| Kategorie | Pfad | Hinweis |
|-----------|------|---------|
| **CODE** | `~/dev/harness` | Das Git-Repo, aus dem der Daemon läuft. **Produktiv-Repo** — niemals auf diesem Repo branchen/arbeiten; dafür Worktrees nutzen. |
| **Unit** | `harness-daemon` | systemd-User-Unit (`~/.config/systemd/user/harness-daemon.service`), `Restart=on-failure`, `RestartSec=5`, `KillSignal=SIGTERM`. Exit-Code `1` → systemd startet neu. |
| **Env** | `%h/harness/.env` | `EnvironmentFile` der Unit (plus daemon-eigenes dotenv-Loading). |
| **HOME** | `~/harness` (`$HARNESS_HOME`) | Durables Agent-Substrat: `core.md`, `AGENTS.md`, `config.json`, `memory/`, `sources/`, `skills/`. Eigenes Git-Repo, portabel. |
| **STATE** | `~/.harness` (`$HARNESS_STATE`) | Ephemeraler Runtime-State: `sessions/`, `metrics/`, `index/`, `logs/`, `daemon.pid`, `daemon.sock`, `last-known-good`, `deploy-rollback.log`, `pending-restart.json`. Regenerierbar, **nicht** in Git. |
| **Skill** | `~/harness/skills/self-modification/skill.md` | Agent-Skill für Selbst-Änderungs-Aufträge. |

Wichtig: **HOME ≠ STATE ≠ CODE** — niemals vermischen. Siehe `docs/architecture/topology.md`.

---

## Standard-Workflow (Code-Deploy)

```
Auftrag → Feature-Branch (nie main) → Build/Test → Bestätigung Philipp → /deploy <branch> → Post-Restart-Ping
```

1. **Auftrag annehmen.** Bei einem Selbst-Änderungs-Auftrag: dieses Runbook **vollständig** lesen (`docs/architecture/self-modification.md`).
2. **Worktree + Feature-Branch** (der Produktiv-Checkout `~/dev/harness` wird nie angefasst):
   ```bash
   git -C ~/dev/harness worktree add ~/dev/harness-<topic> -b feat/<topic> feat/self-deploy
   cd ~/dev/harness-<topic> && pnpm install
   ```
   Basis ist der aktuelle Feature-Stand (z. B. `feat/self-deploy`, `feat/safe-deploy-runbook`) — **nie main** als Basis für unfertige Arbeit.
3. **Änderung umsetzen** inkl. `docs/changes/feat-<topic>.md`. Commits im Worktree erlaubt, **kein Push**.
4. **Gate lokal grün** machen: `pnpm build && pnpm typecheck` (+ relevante Tests) im Worktree.
5. **Philipp per WhatsApp um Bestätigung bitten** — Code-Deploys passieren **nur** nach Philipps expliziter Bestätigung. Nie eigenmächtig `/deploy` aufrufen.
6. **Philipp schickt `/deploy <branch>`** (z. B. `/deploy feat/safe-deploy-runbook`). Der Daemon:
   - lehnt `main`/`origin/main`/`HEAD` ab (Branch-Pflicht),
   - ruft `scripts/safe-deploy.sh <branch>` auf (Exit-Contract siehe unten),
   - bei Erfolg: Antwort „Deploy prepared, restarting…", Restart-Marker, deferred Neustart (Exit 1 → systemd-Restart),
   - **nach dem Neustart**: „Back online. Reason: … HEAD: …" abwarten — das ist der Post-Restart-Ping.
7. **Verifikation:** Ping abwarten, dann `harness daemon status` / Logs prüfen.

### Exit-Contract von `scripts/safe-deploy.sh <branch>`

| Exit | Bedeutung | main |
|------|-----------|------|
| `0` | Merge ok, Build+Typecheck+Test grün | auf neuem HEAD, Restart bereit |
| `1` | `main` abgelehnt / Merge-Konflikt / Validierungsfehler | unverändert |
| `2` | Merge ok, Build/Test fehlgeschlagen | auf vorherigen HEAD zurückgesetzt (`last-known-good`) |

Jeder andere Exit-Code wird vom Daemon als `BUILD_FAILED` (Rollback erwartet) behandelt. Das Script macht ausschließlich Git + Build/Test; Marker, `/deploy`-Lock, Antwort und Restart gehören dem Daemon (`packages/agent/src/daemon/deploy.ts`).

---

## Watchdog (One-Shot, 90 s nach Deploy)

- `safe-deploy.sh` registriert bei Erfolg einen One-Shot-Timer:
  `systemd-run --user --on-active=90 --unit harness-deploy-watchdog <repo>/scripts/deploy-watchdog.sh`
- `deploy-watchdog.sh` prüft die Daemon-Gesundheit via Socket:
  `node ~/dev/harness/packages/agent/dist/index.js daemon status` (Unix-Socket `$HARNESS_STATE/daemon.sock`), 2 Retries à 15 s.
- **Healthy** → leiser Exit 0 (nichts zu tun).
- **Unhealthy** → Rollback: `git -C ~/dev/harness reset --hard <sha aus last-known-good>` + `pnpm build` + `systemctl --user restart harness-daemon`; Log-Eintrag in `$HARNESS_STATE/deploy-rollback.log`. `flock` verhindert parallele Läufe, der Ablauf ist idempotent (nach dem Restart wird erneut die Gesundheit geprüft).
- Den Watchdog nie manuell ausführen; er ist für den automatischen Pfad reserviert.

---

## Anfrage-Modus (Config/Infra)

| Bereich | Autonomie |
|---------|-----------|
| **Config** (`~/harness/.env`, `~/harness/config.json`) | Autonom änderbar — das ist HOME, nicht CODE. |
| **Config-Reload** | Über `harness reload-config` (hot-reload) — ohne Neustart, wo möglich. |
| **Restart** | Nur über Deferred Restart: `/restart` (WhatsApp), Restart-Marker (`$HARNESS_STATE/pending-restart.json`) oder das `request_restart`-Tool. Niemals direkt killen. |

Regel: **Code** (Repo) → nur nach Philipps Bestätigung via `/deploy`. **Config** → autonom, Restart nur über den Deferred-Restart-Pfad.

### Config-Änderung mit Neustart-Bedarf (agent-seitig)

Braucht eine Config-Änderung einen Neustart (z. B. neue API-Keys in
`~/harness/.env`, Modell-/Provider-/Gateway-Änderungen in `config.json`),
löst der Agent den Restart **selbst** über das `request_restart`-Tool aus:

- **`request_restart(reason)` verwenden** — nie `/restart` beim User
  erbetteln, nie `systemctl`/`kill` nutzen.
- Das Tool plant den Restart nach Ende des aktuellen Turns (Deferred
  Restart, gleicher Marker-Pfad wie `/restart`). Der User bekommt vorher die
  Bestätigungsantwort des Turns, nach dem Neustart die Rückmeldung des
  FollowUp-Turns (Verifikation, dass die Änderung gegriffen hat).
- Falls ein Restart/Deploy bereits ansteht, antwortet das Tool mit
  "restart already scheduled" — dann ist nichts weiter zu tun.
- Während des FollowUp-Turns nach einem agent-initiierten Restart ist
  `request_restart` gesperrt (Loop-Breaker).

---

## No-Gos

- **`kill -9` auf den Daemon** — unterbricht die Baileys-Verbindung, korrumpiert den WhatsApp-Auth-State (QR-Neu-Pairing). Siehe `scripts/restart-daemon.sh`.
- **Zweiter Daemon** — zwei Daemons gleichzeitig korrumpieren den Auth-State (häufigste Ursache für unerwartetes Re-Pairing).
- **`--reset-whatsapp-auth`** — nur bei WhatsApp-Nummernwechsel verwenden (Baileys bindet den Auth-State an die Nummer).
- **Edits an `dist/`** — Build-Artefakte, nicht manuell ändern.
- **Arbeiten auf `main`** — Feature-Branch-Pflicht; `/deploy` lehnt `main` ab.
- **Restart ohne grünen Build** — das Build/Test-Gate von `safe-deploy.sh` ist Pflicht. Im Notfall: Break-Glass (unten).

---

## Break-Glass (manuell, ohne Agent)

Falls der Agent nicht mehr reagiert und der Daemon kaputt ist — händisch ausführen (normaler User-Session):

```bash
git -C ~/dev/harness reset --hard $(cat ~/.harness/last-known-good) \
  && pnpm -C ~/dev/harness build \
  && systemctl --user restart harness-daemon
```

Voraussetzung: `~/.harness/last-known-good` existiert (wird bei jedem erfolgreichen Deploy geschrieben). Falls nicht: manuell auf einen bekannten guten Commit zurücksetzen.

---

## Verwandte Doku

- `docs/changes/feat-self-deploy.md` — Paket A: `/deploy`, `/restart`, Deferred Restart, Restart-Marker.
- `docs/changes/feat-safe-deploy-runbook.md` — Paket B: dieses Runbook, `safe-deploy.sh`, `deploy-watchdog.sh`.
- `docs/architecture/topology.md` — HOME vs. STATE vs. CODE.
- `scripts/restart-daemon.sh` — manueller, race-freier Daemon-Neustart (SIGTERM + Warte-Loop).
