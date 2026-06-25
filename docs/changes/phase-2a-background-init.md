# Phase-2A — Background-Init + Warmup-Gate

**Date:** 2026-06-18  
**Branch:** `feat/phase-2a-ambient-hook`

---

## Was wurde implementiert

`MemoryService.init()` blockiert nicht mehr auf `update()` + `embed()`. Stattdessen:
- `init()` macht nur `createStore` + `ensureCollections` (schnell) → TUI startet sofort
- `update()` + `embed()` laufen asynchron im Hintergrund (`warmupPromise`)
- `getBackend()` gibt während Warmup einen `WarmupGatedBackend` zurück

## Warmup-Gate Verhalten

| Methode | Während Warmup | Nach Warmup |
|---------|---------------|-------------|
| `getAmbientHints()` | `[]` (still, nicht-blockierend) | Normale Ergebnisse via `QmdBackend` |
| `query()` | Klare "index warming" Meldung | Normale Ergebnisse via `QmdBackend` |
| `search()` | Awaitet Warmup, dann normale Ergebnisse | Normale Ergebnisse |
| `write()` | Awaitet Warmup, dann Write | Normale Ergebnisse |

Nach Warmup-Abschluss liefert `getBackend()` direkt den `QmdBackend` (kein Gate mehr).

## Dateien

| Datei | Änderung |
|------|---------|
| `src/core/memoryService.ts` | `WarmupGatedBackend` Klasse; `init()` umgeschrieben (background warmup); `warmupDone` Flag; `getBackend()` liefert realen Backend nach Warmup; `shutdown()` wartet auf Warmup |
| `tests/core/memoryService.test.ts` | 14 Tests (9 bestehend angepasst + 5 neue Warmup-Gate Tests) |
| `docs/architecture/memory.md` | §4 "MemoryService" aktualisiert: Background-Init, Warmup-Gate Tabelle |

## Test Counts

| Stage | Tests | Status |
|-------|-------|--------|
| Baseline | 303 passed | ✅ |
| After Background-Init | 308 passed | ✅ |

**Delta: +5 tests** (memoryService: 9 → 14). Keine Regressionen.

## Design-Entscheidungen

- **Ambient → `[]` während Warmup:** Der Ambient Hook läuft vor jedem Turn automatisch. Eine "warming" Meldung würde den System-Prompt verschmutzen. Stille leere Liste ist das richtige Verhalten — der Agent funktioniert ohne Memory, bis es verfügbar wird.
- **`search_memory` → "index warming" Meldung:** Das Tool wird vom Agent bewusst aufgerufen. Eine leere Liste wäre irreführend (könnte bedeuten "keine Treffer"). Die Meldung sagt klar: probier es gleich nochmal.
- **`search()` und `write()` awaiten:** Diese Methoden werden nicht im heißen Turn-Pfad aufgerufen. Blockieren ist akzeptabel.
- **`shutdown()` wartet auf Warmup:** Verhindert, dass der Store geschlossen wird, während `embed()` noch läuft.
- **Pre-warm nach `embed()`:** Ein Dummy-`searchVector("warmup", { limit: 1 })`-Call lädt das Embedding-Modell in den Speicher, bevor der erste User-Turn kommt. Eliminiert ~1–2s Cold-Start auf dem ersten Ambient Hint. Best-effort, Fehler werden ignoriert.
