# feat: Skills deaktivieren (disabled-Flag) + /skills & /skill Slash-Commands

## Problem/Symptom

Das Skill-System kannte nur Alterungs-Zustände (`status: draft|active|stale|archive`).
Es fehlte eine bewusste, operator-gesteuerte Abschaltung:

- `load_skill` lud **jeden** Skill, auch stale/archive — die Lücke war bekannt.
- Es gab keine Möglichkeit, einen Skill hart auszuschließen (Hot-Set, Suche,
  Laden), ohne ihn zu löschen.
- `find_skill`/Hot-Set filterten nur über `routable`/`status` — kein Hard-Off.

## Befund

`createLoadSkillTool` in `packages/core/src/tools/loadSkill.ts` prüfte den Status
gar nicht — nur Existenz. `computeRoutableSkills` (find_skill) berücksichtigte nur
`routable` + incoming-requires. `buildHotSet` filterte nur auf `status === "active"`.

## Geändert

- **`packages/core/src/skills/types.ts`**: neues optionales Frontmatter-Feld
  `disabled: boolean` (Default `false`).
- **`packages/core/src/skills/frontmatter.ts`**: Parser liest/validiert `disabled`
  (`true|false`, sonst `SkillFrontmatterError`).
- **`packages/core/src/skills/hotSet.ts`**: `disabled: true` → nie im Tier-0-Hot-Set
  (auch nicht bei `pinned: true`).
- **`packages/core/src/skills/loader.ts`** (`computeRoutableSkills`): `disabled: true`
  → nie routable, nie in find_skill-Ergebnissen (härter als stale/archive-Flag).
- **`packages/core/src/tools/loadSkill.ts`**: harte Verweigerung mit klarem Fehler
  „Skill `<name>` ist deaktiviert (disabled: true). Erst enablen." — vor Telemetrie,
  keine `recordSkillUse`.
- **`packages/agent/src/daemon/runtime.ts`** (Channel-Slash-Command-Schicht):
  - `/skills` — Übersicht: `Name: status [disabled]`, liest direkt von Disk
    (state files, nicht in-memory).
  - `/skill disable|enable <name>` — setzt das Flag im Frontmatter der `skill.md`
    (persistiert, überlebt Restart), unbekannter Name → Fehler + Hinweis auf `/skills`.
  - `applyDisabledSkills()` beim Start: persistierte Flags überschreiben die
    in-memory Records (Restart-Survival).
  - `/help` listet die neuen Befehle.
  - Neue freie Helfer `parseFlatFrontmatter`/`setFrontmatterField` (CRLF-sicher).
- **`packages/agent/src/cli/doctor.ts`**: deaktivierte Skills als eigene Sektion
  „Disabled Skills (bewusst deaktiviert)", nicht als Dark Skills; Dark-Skill-Filter
  schließt disabled aus; Inventory zeigt `⊘`.

## Dateien

- `packages/core/src/skills/types.ts`, `frontmatter.ts`, `hotSet.ts`, `loader.ts`
- `packages/core/src/tools/loadSkill.ts`, `findSkill.ts`
- `packages/agent/src/daemon/runtime.ts`, `packages/agent/src/cli/doctor.ts`
- Tests: `packages/core/tests/skills/skills.test.ts` (+disabled-Fälle),
  `packages/agent/tests/daemon/skillCommands.test.ts` (neu)

## Tests

- Core `skills.test.ts`: 47 (vorher 39) — Parser-Validierung disabled, Hot-Set-
  Ausschluss (auch pinned), Routability, load_skill-Verweigerung (inkl. keine
  Telemetrie), find_skill-Ausschluss.
- Agent `skillCommands.test.ts` (neu): 6 — disable/enable-Persistenz im
  Frontmatter, Restart-Survival, `/skills`-Ausgabe, unbekannter Skill.
- Agent gesamt: 606 grün. Core: nur bekannter `exec.test.ts` „elevated > id -u"
  rot (Umgebungsproblem, sudo-Passwort nötig — vorbelastet, ignoriert).
