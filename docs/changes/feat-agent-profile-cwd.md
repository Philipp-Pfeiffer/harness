# Feat: Agent-Profilen ein WorkingDirectory geben (cwd)

**Datum:** 2026-08-10
**Branch:** `fix/agent-profile-cwd`

## Problem / Symptom

Cron-Jobs und Subagents liefen im Daemon-CWD (systemd-Unit: `~/dev/harness`).
Die Pipeline-Profile arbeiten aber auf dem Memory-Substrat (`~/harness`):
`distillation-daily` sucht z. B. `memory/_inbox.md` — mit dem Daemon-CWD als
Basis landete der Zugriff auf relative Pfade im falschen Verzeichnis.

## Befund

Jeder Agent soll sein Arbeitsverzeichnis selbst bestimmen. Das Profil-
Frontmatter bekommt ein optionales Feld `cwd`; fehlt es, gilt unverändert das
Daemon-CWD (kein Breaking Change).

**Design-Entscheidung gegen `process.chdir`:** Der Daemon führt parallele
Sessions (WhatsApp, Cron, IPC) in einem Prozess. `process.chdir` im Turn wäre
ein Race-Hazard — während Session A in `~/harness` arbeitet, würde ein
paralleler Turn von Session B das Prozess-CWD verbiegen. Stattdessen fließt
`cwd` als Kontext durch: Profil-Frontmatter → `ProfileAgentContext.cwd` →
`RunOptions.cwd` → `ToolCallContext.cwd` → Pfad-Auflösung der Tools
(`exec`/`readFile`/`write`/`edit`). Nichts Globales wird mutiert, parallele
Sessions mit unterschiedlichen Profilen können gleichzeitig laufen.

## Was geändert wurde

### Profil-Frontmatter

- `packages/core/src/profiles/types.ts`: `AgentProfileFrontmatter.cwd?:
  string | null` (fehlendes Feld = `null`).
- `packages/core/src/profiles/frontmatter.ts`: `cwd` in `KNOWN_KEYS`
  aufgenommen; geparst als optionaler String (`~/harness` und absolute Pfade),
  leer/fehlend → `null`.

### cwd-Durchreichung bis in die Tools

- `packages/core/src/tools/types.ts`: `ToolCallContext.cwd?` (dokumentiert
  als Basis für relative Pfade der Tools, unterstützt `~`).
- `packages/core/src/core/agent.ts`: `RunOptions.cwd?` → wird in den
  `ToolCallContext` jedes Tool-Calls übernommen.
- `packages/core/src/tools/path_util.ts`: `resolveExpandedPathFrom(base, path)`
  (Tilde-Expansion von base + Pfad); `resolveCwd(cwdArg, baseCwd)` für exec.
- `readFile`/`write`/`edit`: relative Pfade + `conflictKey`-Basis via
  `context.cwd`.
- `exec`/`execPty`/`execBackground`: `baseCwd` an `resolveCwd` — ein explizites
  `cwd`-Argument des Tools gewinnt, relative Angaben und das Default lösen
  gegen die Profil-Basis auf.

### Runtime (runCronAgentJob / triggerSessionEndJob)

- `packages/agent/src/daemon/runtime.ts`: `ProfileAgentContext.cwd:
  string | null`, gesetzt aus `frontmatter.cwd`; alle `agent.run()`-Aufrufe im
  Daemon (submit-turn, post-restart-Follow-up, WhatsApp-Turn) reichen
  `cwd: turnCtx.cwd` an `RunOptions` weiter. Damit gilt das Profil-CWD auch für
  reguläre Profil-Sessions, nicht nur für Cron-Jobs.
- Fallback-`default`-Profil in `resolveProfile()` liefert `cwd: null`.

### Profile (Built-ins)

`cwd: ~/harness` ergänzt bei:

- `packages/agent/agents/distillation-daily/agent.md`
- `packages/agent/agents/distillation-wiki/agent.md`
- `packages/agent/agents/session-end/agent.md`
- `packages/agent/agents/curator-stage1/agent.md`
- `packages/agent/agents/curator-stage2/agent.md`

`browser` und `default` bleiben ohne `cwd` (Default-Verhalten).

## Tests

- `packages/core/tests/profiles/profiles.test.ts` (+3): `cwd` wird geparst
  (`~`/absolut), fehlendes `cwd` = `null`, Loader lädt das Feld durch,
  Built-ins: 5 Pipeline-Profile mit `~/harness`, `browser`/`default` ohne.
- `packages/agent/tests/daemon/cronAgentJob.test.ts` (+2): `runCronAgentJob`
  reicht das Profil-CWD in die `run()`-Optionen; ohne `cwd` bleibt
  `options.cwd` `undefined`.

## Validierung

- `pnpm build` / `pnpm typecheck` grün (core + agent).
- Profil-/Daemon-Suiten grün: core `profiles.test.ts` (26), agent
  `cronAgentJob.test.ts` (7), `agentProfiles.test.ts` (11).
- Pre-existing (auf unverändertem `main` identisch fehlschlagend, nicht durch
  diesen Change): core `tests/tools/exec.test.ts` (sudo/elevated),
  agent `tests/cli/non-tty.test.ts`.

## Nicht im Scope

- Kein Push, kein Daemon-Restart, kein systemd-Unit-Edit.
