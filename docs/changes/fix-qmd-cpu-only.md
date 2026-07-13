# fix: QMD Memory-Stack — CUDA-Bibliotheken eliminiert, Embeddings-only bestätigt

## Problem/Symptom

Der Daemon verbrauchte ~1.5 GB RSS. Verdacht: QMD lädt 3 GGUF-Modelle (Embedder + Reranker + Query-Expansion), obwohl nur der Embedder erlaubt ist.

## Befund

**Diagnose via `/proc/<pid>/maps`:**

1. **Nur 1 GGUF geladen** — `embeddinggemma-300M-Q8_0.gguf` (312 MB). Kein Reranker, keine Query-Expansion. Die Modelle sind lazy; `QmdBackend.query()` ruft nur `searchLex()` + `searchVector()` + eigene RRF auf, nie `store.search()` / `store.expandQuery()` / `store.rerank()`.

2. **RAM kam von CUDA/cuBLAS-Bibliotheken** — node-llama-cpp lud das CUDA-Addon (`@node-llama-cpp/linux-x64-cuda`), das `libcublasLt.so` (367 MB), `libcuda.so` (75 MB), `libnvidia-gpucomp.so` (61 MB) etc. mmap'te. Gesamt: ~900 MB file-backed mappings, die auf dieser Maschine (kein NVIDIA GPU für Inference genutzt) wertlos sind.

3. **RSS-Breakdown nach Fix:**
   - Pss: 1.16 GB (vorher 1.27 GB Pss)
   - Pss_Anon: 307 MB (V8 heap + llama.cpp context)
   - Pss_File: 859 MB (GGUF 312 MB + Node + Shared Libs + CJK Fonts ~250 MB)
   - QMD-spezifisch: ~450 MB (GGUF + llama.cpp runtime)
   - Das 200 MB-Ziel ist mit einem lokalen 300M-Modell (Q8_0 = 312 MB Gewichte) nicht erreichbar.

## Was geändert wurde

- **`packages/agent/src/core/memoryService.ts`**: `QMD_FORCE_CPU=1` wird in `init()` gesetzt, bevor `createStore()` aufgerufen wird. Das bewirkt `resolveLlamaGpuMode() === false` im QMD-SDK → node-llama-cpp lädt nur noch das CPU-Addon (`libggml-cpu-haswell.so`), nicht mehr das CUDA-Addon.

- **`packages/agent/tests/core/qmdBackend.test.ts`**: Zwei neue Regressionstests:
  - `regression: query path never calls store.rerank` — stellt sicher, dass `query()` nie den LLM-Reranker aufruft.
  - `regression: vsearch path never calls store.rerank or store.search` — stellt sicher, dass `vsearch()` nie den Hybrid-Pfad (expand + rerank) triggert.
  - `rerank`-Spy zum `createFakeStore()` hinzugefügt.

## Welche Dateien

- `packages/agent/src/core/memoryService.ts` (1 Zeile: `QMD_FORCE_CPU` env setzen)
- `packages/agent/tests/core/qmdBackend.test.ts` (+2 Tests, +1 mock entry)

## Tests

- `CI=true pnpm -r test` → 541/541 grün (325 core + 216 agent, +2 neue)
- `pnpm -r build` → clean
- `tsc --noEmit` → clean
