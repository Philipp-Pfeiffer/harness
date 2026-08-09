# Feat: Pipeline-Trigger verdrahten (Session-End-Hook + Distillation-Cron)

**Datum:** 2026-08-09
**Branch:** `fix/pipeline-triggers`
**Basis:** Pipeline-Profile deployed (`@preset/deepseek-flash`), Bausteine (Session-Logging, Cron-Scheduler, `runCronAgentJob`) vorhanden.

## Problem / Symptom

Die Pipeline-Bausteine existierten, aber die Trigger fehlten: Nach einem
`endSession()` wurde kein Session-End-Protokoll erstellt, und für die
nächtliche Distillation gab es keinen Cron-Job. Zwei Blockaden traten dabei
zutage:

1. **`@preset/`-Modelle in Profilen nicht auflösbar:** `agentContextFor()`
   rief `resolveModel(fm.model.provider, fm.model.model)` — für
   `@preset/deepseek-flash` ergab das `resolveModel("@preset", ...)` und
   einen `Unknown provider '@preset'`-Fehler. Presets existieren nur in
   `config.json` (`provider: openrouter`, `model: @preset/...`) und werden
   über `resolveModelFromConfig` aufgelöst. Damit konnte **kein**
   Pipeline-Profil eine Session starten.
2. **Job-File-Format verlangte Body:** `parseCronJobFile` verlangte für
   `type: agent` einen nicht-leeren Body. Der gewünschte
   `distillation-daily`-Job (Agent liest Summaries + `_inbox.md`
   selbstständig) braucht keinen Body — der Scheduler hätte die Datei als
   fehlerhaft verworfen.

## Befund

- `agentContextFor()` (`packages/agent/src/daemon/runtime.ts`) nutzte den
  rohen `resolveModel()`-Pfad, der Presets nicht kennt.
- `parseCronJobFile()` (`packages/agent/src/daemon/jobs.ts`) verlangte
  Body für alle Job-Typen.

## Was geändert wurde

### 1. `@preset`-Auflösung in `agentContextFor()` (runtime.ts)

Profile mit `model: @preset/<name>` werden jetzt über die `configModels`
(`$HARNESS_HOME/config.json`) aufgelöst (`resolveModelFromConfig`).
Unbekannte Presets werfen einen klaren Fehler; alle anderen
`provider/model`-Refs laufen unverändert über `resolveModel`.

### 2. Session-End-Hook (runtime.ts)

Neuer privater Helfer `triggerSessionEndJob(transcriptPath)` — Fire-and-Forget:
startet `runCronAgentJob("session-end", { transcript: <path> })`. Fehler werden
geloggt (`session-end job failed`), blockieren den Session-Close nie.

Aufgerufen nach **jedem** `endSession()`:
- IPC `end-session` (in-memory + disk-only)
- WhatsApp-Session-Rotation (`rotateWhatsAppSession`)
- Slash-Commands `/new`, `/end`, `/resume`

### 3. `runCronAgentJob`-Overload (runtime.ts)

- `runCronAgentJob(job: CronJob)` — unverändert, plus: leerer Body → Default-Trigger
  `Starte den Auftrag "<name>" gemäß deinem Agent-Profil.` als erster Turn.
- `runCronAgentJob(agent: string, input: { transcript: string })` — Ad-hoc-Run
  für interne Hooks. Für `session-end` baut er den Turn: Transkript lesen +
  Protokoll nach `<transcript>.protocol.md` schreiben.

### 4. Body optional für Agent-Jobs (jobs.ts)

`parseCronJobFile` verlangt Body nur noch für `type: script`. Agent-Jobs mit
leerem Body sind gültig (Profil beschreibt die Aufgabe).

### 5. session-end Profil (agent.md)

`tools: readFile` → `readFile, write` (Protokoll wird geschrieben). Neuer
Abschnitt "Ausführung": Auftrag kommt als erster Turn mit Transkript- und
Zielpfad; Antwort danach nur Protokollpfad + eine Zeile.

### 6. Cron-Job `distillation-daily`

`~/.harness/jobs/distillation-daily.md` angelegt (außerhalb des Repos, STATE):
`name`, `agent: distillation-daily`, `schedule: "0 3 * * *"`, `type: agent`,
kein Body. Der Scheduler pickt die Datei per `fs.watch` ohne Reload.

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/agent/src/daemon/runtime.ts` | `@preset`-Auflösung, `runCronAgentJob`-Overload, `triggerSessionEndJob`, Hook-Aufrufe an 5 Stellen |
| `packages/agent/src/daemon/jobs.ts` | Body nur für script-Jobs required |
| `packages/agent/agents/session-end/agent.md` | `write`-Tool + Ausführungs-Regel |
| `packages/agent/tests/daemon/agentProfiles.test.ts` | Test: `@preset`-Modell via configModels |
| `packages/agent/tests/daemon/cronAgentJob.test.ts` | Tests: Overload, fehlender Input, Session-End-Hook |
| `packages/agent/tests/daemon/cronJobs.test.ts` | Empty-Body-Tests (script required / agent optional) |
| `~/.harness/jobs/distillation-daily.md` | Neuer Cron-Job (STATE, nicht im Repo) |

## Tests

- `pnpm build` / `pnpm typecheck` grün (core + agent)
- Daemon-Suite (`packages/agent/tests/daemon`): 19 Files, 156 Tests grün
- Core-Profile/Pfad-Tests: 32 grün
- Bekannt pre-existing: `tests/cli/non-tty.test.ts` schlägt auf unverändertem
  `main` ebenfalls fehl (unabhängig von diesem Change).

## Nicht im Scope

- Distillation-Pass-Verkettung (Runner-Verkettung Curator etc.)
- `{datum}`-Platzhalter im distillation-daily Profil (bleibt unsubstituiert,
  Agent kennt das Datum selbst — dokumentiert in `feat-distillation-prompts.md`)
