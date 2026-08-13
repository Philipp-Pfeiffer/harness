# feat: Generisches Subagent-Tool `subagent(action, role, task)`

## Problem

Der Main-Agent brauchte einen Weg, klar abgegrenzte Aufgaben (z. B. Coding-Tasks)
an dedizierte Hintergrund-Agenten zu delegieren, ohne den eigenen Turn zu
blockieren. Browser-Subagenten existierten bereits, aber als monolithisches
Subsystem mit eigener Session- und Worktree-Verwaltung — nicht erweiterbar für
weitere Rollen.

## Zielbild

EIN Tool für alle Subagenten: `subagent(action: start|status|stop, role, task, [repo], [model], [handle])`.
`role` bestimmt Persona + Toolset + Default-Modell. Neue Rollen = neue
Prompt-Datei + ein Map-Eintrag in `subagentRoles.ts` — keine neue Tool-Datei,
kein Eingriff in den Agent-Loop.

## Was geändert wurde

### Core (`packages/core`)

- `src/tools/processSupervisor.ts` — `TaskType` um `"agent"` erweitert
  (`"browser" | "agent"`).
- `src/agent/asyncAgentRunner.ts` (neu) — generischer Task-Runner nach dem
  `asyncRunner`-Muster: `createAsyncAgentRunner(opts)` mit
  - `start({role, task, repo?, model?, requesterSessionId?})` — Cap-Check
    (Default 2), `randomUUID`-id, `AbortController`, `registerTask(type:
    "agent")`, Timeout → `abort` + `finalize("error","timeout")`, dann
    agent.run mit rollenaufgelöster Persona/Tools/Modell. Rückgabe sofort
    `{ok:true, id}` bzw. `{ok:false, error, runningIds}`.
  - `finalize` (idempotent): Status/Summary/finishedAt, Artefakt
    `$HARNESS_STATE/agent-runs/<id>/result.json`, Completion-Event
    `{origin:"Subagent", text: buildEventText()}` geroutet über
    `resolveReportTarget(requesterSessionId)` (phoneOverride).
  - `status(id)`/`stop(id)` über `processSupervisor`.
  - Runner erzeugt selbst **keine** Worktrees/Sessions — Worktree ist
    role-spezifisch (coder). Session-Store-Integration ist als v2-Ausblick im
    Code vermerkt.
- `src/agent/subagentRoles.ts` (neu) — Rollen-Registry: `role → {promptFile,
  toolNames, defaultModelRef}`. Erste Rolle `coder`: `subagent-coder`-Prompt,
  Tools `["readFile","write","edit","exec","process"]`, Default-Modell
  `@preset/deepseek-flash`. Resolver:
  - `resolveRolePrompt(role)` → `prompt(promptFile)`
  - `resolveRoleTools(role, loadedTools)` — filtert auf toolNames und schließt
    Channel-Tools (`send_file`, `send_sticker`, `call_user`,
    `report_to_main_session`, `request_restart`, `hang_up`) sowie
    Browser-/Image-Tools aus.
  - `resolveRoleModel(role, overrideModelRef)` — override > role-Default >
    config-default (Preset-Auflösung wie im Browser-Runner).
- `prompts/subagent-coder.md` (neu) — Persona (siehe unten).
- `src/agent/asyncAgentRunner.ts` — coder-Worktree (role-spezifisch): bei
  `role === "coder"` und `repo` wird vor `agent.run` ein Git-Worktree angelegt
  (`git -C <repo> worktree add <repo>-coder-<id> -b coder/<slug>`), der
  Agent erhält im Task-Text einen Präfix mit Worktree-Pfad + Branch
  ("Arbeite ausschließlich hier."). Worktree wird nach Ende NICHT
  automatisch entfernt (Merge-Entscheidung beim Betreiber). Fehler →
  `finalize("error", ...)` ohne agent.run.
- `src/tools/subagent.ts` (neu) — `subagentTool` mit TypeBox-Parametern
  `action: "start"|"status"|"stop"`, `role`, `task` (required bei start),
  `repo`, `model`, `handle` (required bei status/stop). Capability:
  `ToolCallContext.subagentRunner`; ohne Runner → `err("Kein Subagent-Runner
  verfügbar ...")`. Tool-Description coacht den Main-Agenten (Briefing muss
  Ziel, Code-Anker, Verifikation, Done-Kriterien, Verbote enthalten).
- `src/tools/types.ts` — `SubagentRunner`-Interface +
  `subagentRunner?: SubagentRunner` in `ToolCallContext`.
- `src/core/agent.ts` — `RunOptions.subagentRunner`, Durchreichung in
  `ToolCallContext`. Zusätzlich: `RunResult` mit `error`-Feld bei
  `max_turns_exhausted` (der Runner unterscheidet damit "Turn-Limit" von
  "normal beendet" und finalisiert als `error` statt `done`).
- `src/tools/registry.ts` — `LoadToolsOptions.subagent?: {runner}`; das
  `subagent`-Tool wird nur registriert, wenn ein Runner vorhanden ist
  (daemon-seitig).
- `src/config/paths.ts` — `agentRuns`-Pfad (`$HARNESS_STATE/agent-runs`) +
  `ensureDirs`.
- `src/lib.ts` — öffentliche Exports (Runner, Rollen-Resolver, Tool).
- `src/tools/index.ts` — fehlende Tool-Exports ergänzt (für Tests).

### Daemon (`packages/agent`)

- `src/daemon/runtime.ts` — in `initAgent()` wird `createAsyncAgentRunner`
  erzeugt (mit `injectSystemEvent` und `resolveReportTarget: (sessionId) =>
  whatsappSessionToSource.get(sessionId) ?? config.whatsapp?.ownerPhone`) und
  über `loadTools({subagent: {runner}})` sowie `agent.run({subagentRunner})`
  injiziert. Keine weiteren Änderungen; `completeTasksOnRestart()` deckt
  laufende Tasks beim Daemon-Restart ab.

## Completion-Routing

Der Runner liefert das Abschluss-Event über `injectSystemEvent({origin:
"Subagent", text, phoneOverride})`. Das `phoneOverride` kommt aus
`resolveReportTarget(requesterSessionId)`:
`whatsappSessionToSource.get(sessionId) ?? config.whatsapp?.ownerPhone`.
Das heißt: anfordernde Session (sofern bekannt) > Owner-Phone-Fallback. Damit
erreicht das Completion-Event den Chat, der den Subagent gestartet hat —
anders als beim Browser-Subagent (der immer an den Owner meldet).

## Tests

- `tests/subagent/asyncAgentRunner.test.ts` (neu, 17 Tests): TaskType
  "agent" registrierbar; Cap-Check (maxConcurrent + runningIds); status/stop
  für unbekannte ids; stop-Übergang; result.json + Summary; Completion-Event
  (Text mit Summary/Artefakten/Worktree-Branch); Fehlerpfad
  (Provider-Fehler → error-Event); Timeout → error-Event mit "timeout";
  report-target-Routing (anfordernde Session vs. kein Override); Worktree-
  Anlage (git worktree list enthält `<repo>-coder-<id>`, Branch im Event);
  Worktree-Fehlerpfad (nicht existentes Repo → error-Event).
  - Hinweis: pi-ai-`stream` wird gemockt; `mockImplementationOnce` beim
    Timeout-Test ist absichtlich durch `mockImplementation` ersetzt, da die
    Mock-Implementierung der vorherigen Tests (`mockReset` in `beforeEach`
    mit Folge-`mockImplementation` des "erledigt"-Streams) sonst wieder
    hineinragt — der Timeout-Test muss seinen hanging stream behalten, bis
    der Abort finalisiert hat.
- `tests/subagent/subagentTool.test.ts` (neu, 8 Tests): Capability-Gate;
  start-Dispatch (id/worktree/branch im Text); task-Pflicht; start-Fehler
  inkl. runningIds; status/stop-Dispatch; handle-Pflicht; requesterSessionId
  wird durchgereicht.
- `tests/agent.test.ts` — Turn-Limit-Assertion um das neue `error`-Feld
  ergänzt.
- Bekannte Rots (unverändert vorhanden, nicht durch diesen Change verursacht):
  `exec.test.ts` (elevated/id -u, braucht passwordless sudo),
  `obscura.test.ts` (SIGTERM→SIGKILL, Umgebungsabhängig),
  `output/pipeline.test.ts` Snapshot (Trailing-Newline-Diff, bereits auf main
  rot).

## Ergebnis

- `CI=true npx vitest run packages/core` → 617 passed / 2 failed (nur
  bekannte Rots: exec-sudo, obscura-timeout).
- `CI=true npx vitest run packages/agent` → 653 passed / 1 failed (Snapshot
  bereits auf main rot).
- `pnpm build` grün, `pnpm typecheck` grün.
- Commits: siehe Git-Log des Branches `feat/subagent-tool` (nicht gepusht).

## Offene Punkte

- Worktree wird nach Abschluss nicht automatisch entfernt (gewollt, v2: Merge-
  oder Cleanup-Automatik).
- Session-Store-Integration (`createSubAgentSession`) bewusst NICHT in v1 —
  Task + result.json ist die richtige Form für Fire-and-Forget.
- Weitere Rollen (z. B. "researcher") = neue Prompt-Datei + Map-Eintrag.
