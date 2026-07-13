# fix: QMD Memory-Stack auf Benchmark-Architektur festgezurren

## Problem/Symptom

Memory-Stack sollte auf die beschlossene Architektur festgezurren (Benchmark 13.07.):
- embeddinggemma-300M-Q8_0 bleibt als einziges Modell
- Suchpfad: searchLex + searchVector + eigene RRF (kein LLM-Rerank, keine Query-Expansion)
- RAM-Budget: ~520 MB resident
- Cold-Load (~945 ms) darf nicht im ersten User-Turn landen
- QMD_FORCE_CPU=1 als Default (Benchmark lief über Iris Xe/Vulkan)

## Befund

1. **Prewarm bereits implementiert** — `MemoryService.warmup()` feuert async im Hintergrund (`this.warmupPromise = this.warmup()` ohne `await`). Der Pre-warm-Schritt (`store.searchVector("warmup", { limit: 1 })`) lädt das Embed-Model beim Daemon-Start, nicht im ersten User-Turn. Init blockiert nicht.

2. **Nur 1 GGUF geladen** — via `/proc/<pid>/maps` verifiziert: nur `embeddinggemma-300M-Q8_0.gguf`. Kein Reranker, kein Query-Expansion. Die Spy-Tests bestätigen: `store.search()`, `store.expandQuery()`, `store.rerank()` werden nie aufgerufen.

3. **Warm-Latenz mit QMD_FORCE_CPU=1:** Median 125 ms (Range 122-179 ms, 5 Runs). Referenz auf Vulkan: 38 ms. CPU ist ~3x langsamer, aber unter dem 150 ms-Ziel.

4. **QMD_FORCE_CPU=1** eliminiert CUDA/cuBLAS-Bibliotheken (~900 MB file-backed mappings). Nur noch `libggml-cpu-haswell.so` wird geladen.

## Was geändert wurde

### `packages/agent/src/core/memoryService.ts`
- `MemoryServiceConfig.forceCpu?: boolean` — neuer optionaler Config-Parameter (Default: `true`).
  Setzt `QMD_FORCE_CPU=1` wenn nicht `false`. Erlaubt zukünftige GPU-Nutzung ohne Code-Änderung.
- `MEMORY_RSS_BUDGET_MB = 520` — Konstante mit RAM-Budget und Breakdown-Kommentar.
- Init-Log zeigt RSS-Budget: `memory service ready (db: ..., RSS budget ~520 MB, ...)`.

### `packages/agent/tests/core/qmdSmoke.test.ts`
- Map-basierter Regressionstest: nach `store.embed()` + `backend.search()` wird `/proc/self/maps` gelesen.
  Prüft: nur `embeddinggemma`-GGUFs gemappt, keine `query-expansion`/`reranker`/`qwen3-reranker`.
- Ergänzt die bestehenden Spy-Tests in `qmdBackend.test.ts` (die prüfen, dass `store.rerank`/`store.expandQuery` nicht aufgerufen werden) mit einem echten Integration-Test der das OS-level mmap überprüft.

## Warm-Latenz-Messung

```
QMD_FORCE_CPU=1, embeddinggemma-300M-Q8_0, CPU-only (Haswell)
Warm searchVector latencies (ms): 122, 124, 125, 126, 179
Median: 125 ms
Ziel: < 150 ms ✅
Referenz (Vulkan/Iris Xe): 38 ms
```

## Welche Dateien

- `packages/agent/src/core/memoryService.ts` (Config-Erweiterung, Konstante, Log)
- `packages/agent/tests/core/qmdSmoke.test.ts` (Map-Regressionstest)

## Tests

- `CI=true pnpm -r test` → 541/541 grün (325 core + 216 agent)
- `pnpm -r build` → clean
- `tsc --noEmit` → clean
