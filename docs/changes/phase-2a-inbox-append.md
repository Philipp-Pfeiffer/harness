# Phase-2A Step 5 — Inbox Append Pattern (Prompt-Contract)

**Date:** 2026-06-18  
**Branch:** `feat/phase-2a-ambient-hook`  
**Baseline:** Step 4 (292 tests green)

---

## Was wurde implementiert

Eine System-Prompt-Klausel, die den Agent bei explizitem "merk das" / "remember" anweist, einen Bullet an `memory/_inbox.md` via vorhandenem edit-Tool zu appenden. Kein neues Tool, keine neue API, keine Heuristik, keine Session-End-Distillation.

## Dateien

### Geändert

| Datei | Änderung |
|------|---------|
| `prompts/system-prompt.md` | Neue Klausel: Inbox-Append-Contract mit `{{inboxPath}}`-Platzhalter |
| `src/cli/App.tsx` | `prompt("system-prompt", { inboxPath: resolveMemoryConfig().inboxPath })` — Pfad-Substitution |
| `tests/prompts.test.ts` | 7 neue Tests für den Inbox-Append-Contract |
| `docs/architecture/memory.md` | §11 "Inbox Append Pattern" hinzugefügt |

### Neu

| Datei | Zweck |
|------|-------|
| `docs/changes/phase-2a-inbox-append.md` | Dieser Report |

## Test Counts

| Stage | Tests | Status |
|-------|-------|--------|
| Baseline (Step 4) | 292 passed | ✅ |
| After Step 5 | 299 passed | ✅ |

**Delta: +7 tests**. Keine Regressionen.

## Akzeptanzkriterien

- [x] System-Prompt-Klausel erwähnt "merk das" und "remember" als Trigger
- [x] Klausel verweist auf `{{inboxPath}}` (substituiert zur Laufzeit)
- [x] Klausel instruiert Nutzung des edit-Tools (kein neues Tool)
- [x] Klausel instruiert Bullet-Format (`- `)
- [x] Klausel verbietet Heuristik und automatische Zusammenfassung
- [x] Keine Session-End-Distillation erwähnt
- [x] Kein neues Tool, keine neue Tool-API
- [x] Vollständige Test-Suite läuft grün

## Was NICHT implementiert ist (Non-Goals)

- Kein `remember`-Tool
- Keine Intent-Heuristik / Auto-Write
- Keine Session-End-Distillation
- Keine neue Retrieval-Logik
