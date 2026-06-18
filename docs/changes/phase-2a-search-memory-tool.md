# Phase-2A Step 4 — Explicit search_memory Tool

**Date:** 2026-06-18  
**Branch:** `feat/phase-2a-ambient-hook`  
**Baseline:** `c712eb0` (281 tests green)

---

## Was wurde implementiert

Ein explizites `search_memory`-Tool, das `MemoryBackend.query()` (L4 Hybrid + LLM-Rerank) als LLM-verfügbares Tool exponiert. Read-only, keine Writes, keine Message-Mutation.

## Dateien

### Neu

| Datei | Zweck |
|------|-------|
| `src/tools/searchMemory.ts` | Factory `createSearchMemoryTool(memoryBackend?)` + Tool-Definition |
| `tests/tools/searchMemory.test.ts` | 10 Tests: Registry, Query-Forwarding, Trim, Empty, Degraded, Error, No-Ambient-Coupling |
| `docs/changes/phase-2a-search-memory-tool.md` | Dieser Report |

### Geändert

| Datei | Änderung |
|------|---------|
| `src/core/memoryBackend.ts` | `query()` Methode zum `MemoryBackend`-Interface hinzugefügt |
| `src/core/stubBackend.ts` | `query()` implementiert (returns `[]`) |
| `src/tools/registry.ts` | `loadTools(memoryBackend?)` — inkludiert `search_memory` via Factory |
| `src/cli/App.tsx` | `loadTools(memoryService?.getBackend())` — Backend wird durchgereicht |
| `tests/agent.test.ts` | Mock-Backend um `query`-Feld ergänzt (Interface-Konformität) |
| `tests/core/stubBackend.test.ts` | Test für `query()` hinzugefügt |
| `docs/architecture/memory.md` | §10 "Explicit Search Tool (L4)" hinzugefügt; L4 als implementiert markiert; File Map ergänzt |

## Test Counts

| Stage | Tests | Status |
|-------|-------|--------|
| Baseline | 281 passed | ✅ |
| After Step 4 | 292 passed | ✅ |

**Delta: +11 tests** (10 searchMemory + 1 stubBackend query). Keine Regressionen.

## Akzeptanzkriterien

### Functional
- [x] `search_memory` existiert als Tool
- [x] Tool-Name ist exakt `search_memory`
- [x] Tool akzeptiert required `query: string`
- [x] Tool ruft `MemoryBackend.query()` auf
- [x] Tool nutzt NICHT `getAmbientHints()`
- [x] Tool ist in der Registry verfügbar
- [x] Tool ist read-only
- [x] Tool erzeugt keine Memory-Writes
- [x] Tool verändert keine Chat-`messages`
- [x] Tool funktioniert mit leerer Trefferliste
- [x] Missing/degraded MemoryBackend ist konsistent behandelt (graceful, kein Throw)
- [x] Backend-Fehler werden nicht stillschweigend verschluckt (erscheint im Tool-Result)

### Tests
- [x] Registry-Test vorhanden
- [x] Query-Forwarding-Test vorhanden
- [x] Query-Trim-Test vorhanden
- [x] Empty-Results-Test vorhanden
- [x] Missing-Backend/degraded-mode-Test vorhanden
- [x] Backend-Error-Test vorhanden
- [x] No-Ambient-Hint-Coupling-Test vorhanden
- [x] Vollständige Test-Suite läuft grün (292 passed)

### Documentation
- [x] `docs/architecture/memory.md` beschreibt `search_memory` als implementiert
- [x] Unterschied zwischen Ambient Hook und explicit search ist dokumentiert
- [x] Step 5 bleibt als offen markiert

## Offener nächster Schritt

**Schritt 5: Inbox-Pattern (`_inbox.md` Append bei "merk das")** — weiterhin nicht implementiert. Keine Intent-Detection, kein Append-Mechanismus im Code.
