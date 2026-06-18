# Phase-2A Step 4 Fix — L4 Explicit Search: RRF statt LLM-Rerank

**Date:** 2026-06-18  
**Branch:** `feat/phase-2a-ambient-hook`  
**Baseline:** Step 4 initial (292 tests)

---

## Problem

`QmdBackend.query()` nutzte `store.search()` — der QMD-SDK-Hybrid-Pfad mit **LLM-Query-Expansion** und **LLM-Reranking**. Das ist ein Scope-Bug in Phase 2A: `search_memory` darf keine LLM-Calls auslösen.

## Fix

`QmdBackend.query()` umgeschrieben auf **BM25 + Vector + RRF** (Reciprocal Rank Fusion):

1. `store.searchLex(query, { limit: k * 3 })` — BM25-Keyword-Search, kein LLM
2. `store.searchVector(query, { limit: k * 3 })` — Vector-Similarity, kein LLM
3. Inline RRF (k=60, equal weights) — fusioniert beide Listen
4. Top-k aus dem fusionierten Resultat

**Kein** `store.search()`, **keine** Query-Expansion, **kein** LLM-Rerank.

## Dateien

| Datei | Änderung |
|------|---------|
| `src/core/qmdBackend.ts` | `query()` auf searchLex + searchVector + RRF umgeschrieben; `HybridQueryResult`-Import entfernt; `reciprocalRankFusion()` inline implementiert |
| `tests/core/qmdBackend.test.ts` | Tests umgeschrieben: 5 neue query-Tests (parallel calls, RRF merge, k-limit, empty, lex-only); `search mode explicit` Test sichert `store.search` nicht aufgerufen |
| `docs/architecture/memory.md` | L4-Beschreibung aktualisiert: RRF statt Hybrid+Rerank, 0 LLM-Calls, Latenz < 200ms |

## Test Counts

| Stage | Tests | Status |
|-------|-------|--------|
| Baseline | 299 passed | ✅ |
| After Fix | 303 passed | ✅ |

**Delta: +4 tests** (qmdBackend: 13 → 17). Keine Regressionen.

## Verifikation

- `store.search` wird in `query()` und `search(mode: "explicit")` **nicht** aufgerufen (getestet)
- `store.expandQuery` wird **nicht** aufgerufen (getestet)
- RRF merged overlapping results korrekt (getestet)
- k-Limit wird nach Fusion angewendet (getestet)
- Build clean (0 TS-Fehler)
