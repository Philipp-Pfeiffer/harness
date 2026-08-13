# feat: Architecture Map — Navigationskarte für Menschen & Modelle

## Problem / Ziel

Eine 30-minütige Repo-Sichtung für neue Menschen und für günstige Modelle soll auf Minuten
schrumpfen. Es gab keine einzelne Übersicht, die Packages, Komponenten, die beiden Monolithen
(`runtime.ts`, `agent.ts`), zentrale Flows und „wie lege ich X an“-Rezepte an einer Stelle bündelt.

## Was geändert wurde

- **Neu:** `docs/architecture-map.md` — eine Navigationskarte mit:
  - Packages & Verantwortungen (core vs. agent) und Einstiegspunkten (Daemon-Main, CLI, Tool-Registry).
  - Komponenten-Karte (Datei → Verantwortung → Zeilen) inkl. Binnenstruktur der Monolithen
    `packages/agent/src/daemon/runtime.ts` (~4019 Zeilen) und `packages/core/src/core/agent.ts` (~1133 Zeilen).
  - Vier Mermaid-Diagramme: (a) Turn-Lifecycle, (b) Tool-Dispatch + Capability-Injection,
    (c) Hintergrund-Task/Subagent, (d) Voice-Call-Flow (Adapter ↔ Daemon via IPC).
  - Rezepte mit Anker-Dateien: Tool, Daemon-Capability, Channel, Subagent, Tool-Typ, Cron-Job.
  - Bekannte Schmerzpunkte (Turn-Persistenz, Channel-Seams, Prozess-Lebenszyklus, Abort-Vertrag) als Refactor-Hebel.

## Dateien

| Datei | Änderung |
|-------|----------|
| `docs/architecture-map.md` | neu |
| `docs/changes/feat-architecture-map.md` | neu (dieser Eintrag) |

## Methode

Kein vollständiges Lesen jeder Datei. Struktur-basiert: `package.json`, Verzeichnisliste,
`wc -l`, Grep auf `export const …Tool`, `class`/`function`-Signaturen, gezielte Reads der Monolithen
und der zentralen Module (`registry.ts`, `types.ts`, `voiceChannel.ts`, `asyncRunner.ts`, `jobs.ts`,
`scheduler.ts`, `inbound.ts`, `plugin.ts`, `paths.ts`, `capabilities.ts`, Audit-Doku).

## Kein Code geändert

Reine Doku. Keine Logik-, Config- oder Code-Änderung.
