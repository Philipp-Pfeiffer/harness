# Change: Safe Self-Deploy Package B — `safe-deploy.sh`, Watchdog, Runbook, Skill

## Übersicht

Paket B der Selbst-Modifikation: sicheres Deployment via `/deploy <branch>`
mit rollback-fähigem Build/Test-Gate, One-Shot-Watchdog (90 s nach Deploy),
Runbook (`docs/architecture/self-modification.md`), Agent-Skill und
AGENTS.md-Abschnitt. Code-Deploys laufen nur nach Philipps Bestätigung;
Config-Änderungen sind autonom; Restarts nur über den Deferred-Restart-Pfad.

## Symptom / Motivation

- Paket A (`feat/self-deploy`) delegiert `/deploy` an `scripts/safe-deploy.sh`
  **falls vorhanden**, sonst Inline-Merge + Build/Test (10-min-Timeout,
  Rollback per `git reset --hard`). Es definiert den Exit-Contract:
  `0` = ok, `1` = Konflikt/Validierung (main unverändert), `2` = Build/Test
  fehlgeschlagen (main auf vorherigen HEAD zurückgesetzt).
- Fehlt: das eigentliche `safe-deploy.sh`, ein **Health-Watchdog** gegen
  "Daemon startet nach Deploy nicht mehr hoch", Runbook/Skill für den
  Agenten und der AGENTS.md-Verweis.

## Befund / Design

### `scripts/safe-deploy.sh <branch>`

- **Arg-Gate:** lehnt `main`/`origin/main`/`HEAD` ab (Exit 1). Branch muss
  lokal existieren (kein Fetch, Repo hat keinen sinnvollen Remote).
- **Pre-Checks:** läuft auf `main`, Working Tree sauber — sonst Exit 1.
- **last-known-good:** vor dem Merge wird `<vollSHA> <branch>` nach
  `$HARNESS_STATE/last-known-good` geschrieben (außerhalb des Repos, damit
  ein Hard-Reset des Repos die Referenz nicht mitnimmt). Format SHA+Branch,
  damit der Watchdog aus jedem Checkout hart auf den richtigen Stand kann
  (kein `safe.directory`-Pfad-Hardening nötig).
- **Merge:** `git merge --no-edit <branch>`. Git-Identität wird auf
  "Harness Agent <agent@harness.dev>" gesetzt, falls keine user.*-Config
  existiert (sonst bricht der Merge mit "Author identity unknown").
- **Gate:** `pnpm install` (15-min-Timeout) → `pnpm build` → `pnpm typecheck`
  → `pnpm --filter @harness/agent test` (je 10-min-Timeout). Bei Fehler:
  `git reset --hard $PREV_HEAD` + `git clean -fdq`, Exit 2.
- **Erfolg:** `systemd-run --user --on-active=90 --unit harness-deploy-watchdog
  <repo>/scripts/deploy-watchdog.sh` registriert den One-Shot-Watchdog
  (bestehende gleichnamige Unit wird überschrieben), Exit 0.
- Greift nie in `$HARNESS_STATE` (außer last-known-good), nie auf den
  Daemon-Prozess.

### `scripts/deploy-watchdog.sh`

- **Lock:** `flock` auf `$HARNESS_STATE/deploy-watchdog.lock` — parallele
  Läufe sind no-op.
- **Health-Check:** prüft den Unix-Socket `$HARNESS_STATE/daemon.sock` und
  ruft `node <repo>/packages/agent/dist/index.js daemon status` (Timeout 10 s).
  3 Versuche à 15 s.
- **Healthy → Exit 0** (leise). **Unhealthy → Rollback:**
  `git checkout -B <branch> <sha>` (aus last-known-good) + `pnpm build` +
  `systemctl --user restart harness-daemon`. Log in
  `$HARNESS_STATE/deploy-rollback.log` (Timestamp, Grund, SHAs).
- **Idempotent:** Re-Run auf bereits-GOOD-Repo ist no-op; nach dem Restart
  wird erneut die Gesundheit geprüft (unhealthy → Exit 1, manueller Eingriff).

### Runbook `docs/architecture/self-modification.md`

Topologie (CODE `~/dev/harness`, Unit `harness-daemon`, Env `%h/harness/.env`,
HOME `~/harness`, STATE `~/.harness`), Standard-Workflow (Auftrag →
Feature-Branch in Worktree → Gate → Bestätigung Philipp → `/deploy <branch>`
→ Post-Restart-Ping), Anfrage-Modus (Config autonom, Restart nur deferred),
No-Gos, Break-Glass, Exit-Contract-Tabelle.

### Skill `~/harness/skills/self-modification/skill.md`

agentskills.io-kompatibel (`name`, `description` mit "Use when:"/"Don't use
when:", `level: atom`, `status: active`) — Format wie bestehende Skills unter
`~/harness/skills/`. Kompakte Pflichtregeln + No-Gos + Deploy-Ablauf, mit
Verweis auf das Runbook.

### AGENTS.md

Kurzer Abschnitt "Selbst-Modifikation" nach der Runtime-Topologie mit Verweis
auf das Runbook (verbindlich, keine Dopplung).

## Geänderte Dateien

| Datei | Änderung |
|-------|----------|
| `scripts/safe-deploy.sh` | **Neu** — Contract 0/1/2, last-known-good, Watchdog-Registrierung |
| `scripts/deploy-watchdog.sh` | **Neu** — Health-Check, Rollback, flock, idempotent |
| `docs/architecture/self-modification.md` | **Neu** — Runbook |
| `AGENTS.md` | Abschnitt "Selbst-Modifikation" + Runbook-Verweis |
| `~/harness/skills/self-modification/skill.md` | **Neu** — Agent-Skill (Home, nicht im Repo) |
| `docs/changes/feat-safe-deploy-runbook.md` | **Neu** — dieser Change-Report |

## Tests / Validierung

- `bash -n` auf beiden Scripts grün. `shellcheck` nicht installiert.
- Trockentest in einer **Kopie** des Haupt-Checkouts (inkl. node_modules,
  eigenes Test-Git-Repo mit main + Feature-Branches):
  - `/deploy main` → Exit 1, main unverändert.
  - nicht-existenter Branch → Exit 1.
  - Merge-Konflikt → `git merge --abort`, Exit 1, main unverändert, kein
    MERGE_HEAD-Rest.
  - build-Failure-Injection → Rollback, Exit 2, main auf vorherigem HEAD.
  - Erfolgspfad: Merge + `pnpm install` (no-op) + build + typecheck + Tests —
    nur `statusSummary.test.ts` schlägt fehl, weil `HARNESS_STATE` auf einen
    Temp-Pfad zeigt (Test erwartet `.harness/metrics`) — reine Test-Env-
    Konfiguration, kein Code-Fehler (Bestandssuite grün mit Default-State).
  - Watchdog: healthy-Pfad (echter Unix-Socket + mock `daemon status` → Exit 0,
    kein Rollback); Rollback-Pfad (unhealthy → checkout -B GOOD + build +
    restart-Versuch); flock blockiert parallele Läufe; Idempotenz (bereits auf
    GOOD → no-op).
- **Befund Umgebung (nicht Teil des Changes):** Der Worktree-Build schlägt
  wegen fehlendem Root-`typebox@1.1.33` fehl (der Haupt-Checkout hat eine
  hand-installierte Root-`typebox` vom 26.04., die `typebox/value` liefert;
  frisches `pnpm install` installiert `typebox@1.3.11` ohne diesen Subpath
  und hoisted es nicht). Kein Code-Fehler von Paket B — separat zu lösen
  (z. B. Lockfile einführen oder `typebox/value`-Import fixen).

## Non-Goals

- Kein TUI/CLI-Change, kein Ändern der systemd-Unit.
- Kein Auto-Rollback-Cron — nur der One-Shot-Watchdog nach Deploy.
- `~/harness/skills/self-modification/skill.md` liegt im HOME (nicht im Repo) —
  wird nicht committet.
