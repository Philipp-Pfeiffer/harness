# Feat: Curator-Pipeline (Stage 1 + Stage 2 + Event-Bus-Ping)

**Datum:** 2026-08-11
**Branch:** `feat/curator-pipeline`
**Basis:** ADR Addendum §12 (Umsetzungsarchitektur, 2026-08-10), System-Event-Bus (`feat/system-event-bus-mail`), Cron-Scheduler + `runCronAgentJob` (`feat-pipeline-triggers`).

## Architektur-Mapping (ADR §12 → gebaut)

| ADR §12 | Gebaut |
|---------|--------|
| Pipeline alle 2 Tage, nachts, versetzt zu distillation-daily (03:00) | Drei Cron-Jobs 04:00/04:15/04:45 an `*/2`-DoM-Tagen (stage1 → stage2 → ping), alle `enabled: false` (manueller Rollout) |
| Stage 1 liest Daily Notes + Session-Protokolle der letzten 2 Tage + Skills-Verzeichnis → Briefing | `curator-stage1/agent.md` umgeschrieben: 2-Tage-Fenster (`memory/daily/` + `~/.harness/sessions/*/*.protocol.md` + `~/harness/skills/`), Briefing nach `~/.harness/curator/briefings/YYYY-MM-DD.md`, YAML-Kopf-Format beibehalten |
| Stage 2 liest Briefing → Report | `curator-stage2/agent.md` umgeschrieben: Report nach `~/.harness/curator/reports/YYYY-MM-DD.md`, nummerierte Vorschläge `[typ: skill-create \| skill-merge \| memory-fix \| frage]`, max. ~10, sortiert nach Tragweite |
| Ping per `injectSystemEvent`, nur Metadaten | Script-Job `curator-ping` (`packages/agent/src/daemon/curatorPing.ts` + Registry in `scripts.ts`), Text: "Curator-Report fertig: N Vorschläge, Pfad …" — nie Report-Inhalt |
| Konzept statt Draft | Stage-2-Profil: pro `skill-create` ein Konzept (Zweck, `skill.md`-Stichpunkte, nötige Skripte/Tools), keine fertigen Dateien |
| Draft-Schwelle gesenkt (1× teures Herumprobieren reicht) | Stage-2-Profil: Failure-Heuristik ersetzt; Zwei-Sessions-Regel nur noch für Behavior-Fixes; Meinungsänderung ≠ Failure |
| Skill-Index `skills/_index.md` | `~/harness/skills/_index.md` angelegt (Name + Zweck + Pfad, 40 Skills) |
| Approval + Bau durch Main-Agent | **Nicht gebaut** (Scope lt. Auftrag) — Stage-2-Profil verweist nur darauf |

## Was geändert wurde

### 1. Profile umgeschrieben (`packages/agent/agents/curator-stage{1,2}/agent.md`)

- Alle Referenzen auf Proto-Skill-Drafts aus der nightly-distillation gestrichen (existieren nicht mehr).
- Input-Fenster Stage 1: letzte 2 Tage; leere/Smalltalk-Sessions herausfiltern; Dedup gegen `_index.md`.
- Stage 2: Konzept-Format, neue Failure-Heuristik, Report-Schema, sauberes Beenden bei fehlendem Briefing (keine Halluzination), Antwort nur Reportpfad + Anzahl (Ping übernimmt der Daemon).
- Frontmatter: `tools` um `exec` ergänzt (beide Profile brauchen `ls`/`date` zum Auflösen der 2-Tage-Ordner), `thinking: true` beibehalten.

### 2. Cron-Verdrahtung (`~/.harness/jobs/` — STATE, nicht im Repo)

Job-Dateien liegen in `$HARNESS_STATE/jobs/` und sind dort nicht versioniert. Damit die Deployment-Artefakte nachvollziehbar sind, liegen identische Vorlagen unter `.harness/jobs/` im Repo; die Tests validieren sie. Der Rollout kopiert sie nach `~/.harness/jobs/` (Anleitung unten).

| Datei | Schedule | Typ | Body |
|-------|----------|-----|------|
| `curator-stage1.md` | `0 4 */2 * *` | agent | leer (Profil beschreibt Aufgabe) |
| `curator-stage2.md` | `15 4 */2 * *` | agent | leer |
| `curator-ping.md` | `45 4 */2 * *` | script | `curator-ping` |

Alle 2 Tage via `*/2` im Day-of-Month-Feld; Monatsgrenze 31.→1. ergibt 1-Tages-Abstand, bewusst akzeptiert. `0 3 * * *` = distillation-daily. Kein stage2→stage1-Trigger im Scheduler vorhanden (`feat-pipeline-triggers.md` dokumentiert keine Verkettung) → zeitversetzt ge­cront; Stage 2 beendet sich sauber, wenn das Briefing des Tages fehlt. **Alle drei Jobs `enabled: false`** — erster Pass wird von Hand getriggert.

### 3. Event-Bus-Ping

**Gewählter Seam:** Script-Job-Funktion im Daemon (bestehender Mechanismus aus `scheduler.ts`/`scripts.ts`), weil er
- deterministisch ist (kein LLM im Pfad — "If code can answer, code answers"),
- den bestehenden `injectSystemEvent`-Pfad direkt nutzt,
- idempotent pro Lauf ist (liest den neuesten Report, zählt nummerierte Vorschläge).

Neu: `packages/agent/src/daemon/curatorPing.ts` (reines Modul, `buildCuratorPingText` + `parseProposalCount`), Registrierung als `curator-ping` in `scripts.ts`, `ScriptJobContext.injectEvent` als optionaler Callback (daemon-setup: `runtime.ts` verdrahtet ihn auf `injectSystemEvent`). **Fehlt der Report, ist er leer oder stammt er nicht von heute → kein Ping** (geloggt, nicht geworfen). Frische-Check: Der neueste Report muss das heutige lokale Datum (`YYYY-MM-DD`) tragen — sonst würde der Ping-Job nach einem laufleeren Stage-2 (kein Briefing/keine Befunde) den Report des letzten Laufs erneut an WhatsApp senden.

Report-Zählung robust: Regex `^\s*\d+\.\s*\[typ: (skill-create|skill-merge|memory-fix|frage)\]` — zählt nur nummerierte Vorschlagszeilen mit gültigem Typ.

### 4. Skill-Index (`~/harness/skills/_index.md`)

Angelegt aus dem aktuellen Verzeichnis (40 Einträge, Name + Zweck + Pfad). Pflege-Regel als Kurzabsatz in `packages/agent/agents/default/agent.md` (dort, wo der Main-Agent/Skill-Bau lebt) — dokumentiert, nicht als eigenes Tool gebaut.

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/agent/agents/curator-stage1/agent.md` | umgeschrieben (2-Tage-Fenster, Briefing-Zielpfad, keine Proto-Drafts) |
| `packages/agent/agents/curator-stage2/agent.md` | umgeschrieben (Konzept statt Draft, neue Failure-Heuristik, Report-Schema) |
| `packages/agent/agents/default/agent.md` | Abschnitt "Skill-Index-Pflege" |
| `packages/agent/src/daemon/curatorPing.ts` | **neu** — Ping-Text-Bau + Vorschlags-Zählung |
| `packages/agent/src/daemon/scripts.ts` | Registry `curator-ping` + `injectEvent` im `ScriptJobContext` |
| `packages/agent/src/daemon/runtime.ts` | Scheduler-Setup verdrahtet `injectEvent` auf `injectSystemEvent` |
| `.harness/jobs/curator-{stage1,stage2,ping}.md` | **neu** — Job-Vorlagen (disabled, `*/2`-DoM) |
| `packages/agent/tests/daemon/curatorPing.test.ts` | **neu** — Ping-Tests |
| `packages/agent/tests/daemon/curatorJobs.test.ts` | **neu** — Job-Frontmatter-Tests |
| `~/harness/skills/_index.md` | **neu** — Skill-Index (40 Skills) |

## Tests

- `curatorPing.test.ts`: Report mit N Vorschlägen → korrekter Event-Text; kein/leerer/staler Report (gestern) → kein Ping; heutiger Report → Ping (Testuhr injiziert via `now`-Option, deterministisch); Zählung robust (nummeriert + Typ, ignoriert andere Zeilen); neuester Report gewinnt; Registry injiziert über Kontext.
- `curatorJobs.test.ts`: Frontmatter gültig (croner-Expression, `enabled: false`, `*/2` im DoM-Feld), Reihenfolge stage1→stage2→ping, Start nach 03:00 (distillation-daily), Profil-Referenzen existieren, Script-Funktion registriert.
- Keine Agent-Output-Tests (LLM-Inhalt); Briefing→Report-Kette ist Profil-Verhalten (kein Code).

## Validierung

- `pnpm build` grün (core + agent)
- `pnpm typecheck` grün (core + agent)
- Agent-Suite: 50/51 Files, 561/562 Tests grün. Einziger Rot: `tests/cli/non-tty.test.ts` — pre-existing Flake, auf unverändertem `main` (b81b9ea) identisch rot.
- Core-Suite: 44/45 Files, 549/550 grün. Einziger Rot: `tests/tools/exec.test.ts` (sudo "Ein Passwort ist notwendig") — pre-existing, ohne passwordless sudo nicht lauffähig (vom Auftrag explizit erlaubt).

## Rollout (manuell, bewusst NICHT ausgeführt)

```bash
cp .harness/jobs/curator-*.md ~/.harness/jobs/
```

Dann erster Pass von Hand triggern (z. B. `runCronAgentJob`-Ad-hoc oder `enabled: true` setzen), Output gemeinsam begutachten, erst danach Cron scharf. Kein Push, kein Restart, kein Deploy in diesem Changeset.

## Bewusst NICHT gebaut

- **Approval-Flow** (✓/✗/Edit durch Philipp + Bau via skill-smith) — Punkt 4 der Pipeline, explizit außerhalb des Auftrags.
- **Lifecycle** (stale/archive via `_telemetry.json`-Mini-Script) — ADR §12: kommt später, deterministic.
- **Proto-Skill-Drafts** — entfallen lt. ADR §12 ersatzlos (Konzept statt Draft).
- **Stage-Verkettung im Scheduler** — kein Trigger/Chaining-Mechanismus vorhanden; zeitversetzte Crons.
- **Curator-Verzeichnisse in `ensureDirs`** — Report-/Briefing-Verzeichnisse legt Stage 2/1 per `mkdir -p` an (im Profil dokumentiert); keine Runtime-Änderung nötig. Ein `curator`-Pfad in `HarnessPaths` bewusst nicht ergänzt (Pfad-Quelle bleibt `paths.ts`, aber es gibt noch keinen Code-Consumer außerhalb der Profile).
