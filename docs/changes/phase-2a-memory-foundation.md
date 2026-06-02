# Phase-2A Memory Foundation Integration Report

**Date:** 2026-05-30  
**Integration Agent:** Kimi Code CLI  
**Baseline HEAD:** `b2b486b` (208 tests green)  
**Final HEAD:** `9e15443` → `f9888dc` (SDK migration)

---

## Commits

### Step 1 — Core Memory System-Prompt Injection

`9a63514` — **feat(memory): core.md loaded into system prompt (Phase 2A Step 1)**
- Adds `core.md` template, `src/core/coreMemory.ts` loader/parser, `setSystemPrompt` to Agent interface.
- Integrates core memory injection into `src/cli/App.tsx`.
- Adds `tests/core/coreMemory.test.ts` (8 tests).

### Step 2 — Markdown Folders + QMD CLI Backend

`9e15443` — **feat(memory): markdown folders + QMD MemoryBackend adapter (Phase 2A Step 2)**
- Adds `src/core/memoryFolders.ts` for idempotent project-local `memory/`, `sources/`, `_inbox.md` creation.
- Adds `MemoryBackend` interface, `QmdBackend` (QMD-CLI adapter via `execFile`), `StubBackend` (fallback).
- Integrates folder scaffolding into `src/index.tsx` startup path.
- Adds tests: `memoryFolders.test.ts` (4), `qmdBackend.test.ts` (10), `stubBackend.test.ts` (3).

### Review Fix 1 — Project-Local Paths

`08fbfec` — **refactor(memory): default memory/sources paths to project root (was ~/)**
- Defaults changed from `~/memory`, `~/sources` to `<projectRoot>/memory`, `<projectRoot>/sources`.
- Env overrides (`HARNESS_MEMORY_PATH`, `HARNESS_SOURCES_PATH`, `HARNESS_INBOX_PATH`) remain.

### Review Fix 2 — Idempotent QMD Auto-Setup

`98603e8` — **feat(memory): idempotent QMD collection auto-setup + real retrieval smoke test**
- Adds `src/core/qmdSetup.ts` with `ensureQmdCollections()`: idempotent collection registration via CLI.
- Adds `tests/core/qmdSetup.test.ts` with mocked `execFile` tests.
- Adds `tests/core/qmdSmoke.test.ts`: real QMD binary E2E (skipped in CI).

`a9c7623` — **docs(memory): project-local paths + auto-setup, update change report**
- Updates `docs/architecture/memory.md` and this report.

### SDK Migration — CLI execFile → `@tobilu/qmd` SDK

`fc88feb` — **WIP: QMD SDK migration (memoryService + qmdBackend + tests)**
- Adds `src/core/memoryService.ts`: lifecycle owner with `createStore()`, `ensureCollections()` via SDK, degraded mode.
- Rewrites `src/core/qmdBackend.ts`: pure SDK usage (`searchVector`, `search`, `update`, `embed`), no more `execFile` or JSON parsing.
- Deletes `src/core/qmdSetup.ts` and `tests/core/qmdSetup.test.ts`.
- Rewrites `tests/core/memoryService.test.ts` (5 tests) and `tests/core/qmdBackend.test.ts` (7 tests) with fake stores.
- Adds `tests/core/qmdSmoke.test.ts` (1 SDK E2E, skipped when native deps unavailable).
- Updates `src/index.tsx` to instantiate `MemoryService`, call `init()`, pass to `<App />`, handle shutdown.
- Updates `src/cli/App.tsx` to accept optional `memoryService` prop.

`f9888dc` — **fix(App.tsx): suppress TS6133 for injected memoryService prop**
- Minor type fix for unused `memoryService` prop (stored in `useRef` for future phases).

### Block 5 — Documentation

*(this commit)* — **docs(memory): SDK architecture, gateway migration path, README update**
- Rewrites `docs/architecture/memory.md` for SDK architecture.
- Updates `README.md` with SDK setup, `QMD_EMBED_MODEL`, `brew install sqlite`.
- Appends SDK migration section to this report.

---

## New Files

| File | Purpose |
|------|---------|
| `core.md` | User-maintainable identity/project context (injected into system prompt) |
| `src/core/coreMemory.ts` | Loader, parser, formatter, composer for core.md |
| `src/core/memoryFolders.ts` | Folder scaffolding with env-configurable paths |
| `src/core/memoryBackend.ts` | `MemoryBackend` interface + `MemoryHit` / `MemoryEntry` types |
| `src/core/memoryService.ts` | **NEW** Lifecycle owner: creates QMD store, ensures collections, update+embed, shutdown |
| `src/core/qmdBackend.ts` | **REWROTE** SDK adapter: `vsearch` (L2), `query` (L4), `search`, `write` |
| `src/core/stubBackend.ts` | No-op fallback implementing `MemoryBackend` |
| `tests/core/coreMemory.test.ts` | Unit tests for core memory loader/parser |
| `tests/core/memoryFolders.test.ts` | Unit tests for folder scaffolding |
| `tests/core/memoryService.test.ts` | **NEW** Unit tests for MemoryService with mocked `createStore` |
| `tests/core/qmdBackend.test.ts` | **REWROTE** Unit tests for SDK-QmdBackend with fake store |
| `tests/core/qmdSmoke.test.ts` | Real SDK E2E smoke test (skipped in CI) |
| `tests/core/stubBackend.test.ts` | Unit tests for stub fallback |
| `docs/architecture/memory.md` | Architecture overview for memory subsystem |
| `docs/changes/phase-2a-memory-foundation.md` | This report |

## Deleted Files

| File | Reason |
|------|--------|
| `src/core/qmdSetup.ts` | Replaced by `MemoryService.ensureCollections()` |
| `tests/core/qmdSetup.test.ts` | Replaced by `memoryService.test.ts` |

## Modified Files

| File | Change |
|------|--------|
| `src/core/agent.ts` | Added `setSystemPrompt` to `Agent` interface and `createAgent` return object |
| `src/cli/App.tsx` | Added core memory load effect; added optional `memoryService` prop |
| `src/index.tsx` | Added `MemoryService` lifecycle: create → init → inject → shutdown |
| `package.json` | Added dependency `@tobilu/qmd` |
| `tests/cli/App.test.tsx` | Added `setSystemPrompt` to agent mocks |
| `tests/cli/ToolCard.test.tsx` | Added `setSystemPrompt` to agent mocks |
| `tests/cli/commands.test.tsx` | Added `setSystemPrompt` to agent mocks |
| `tests/cli/key-warning.test.tsx` | Added `setSystemPrompt` to agent mocks |
| `tests/cli/markdown-rendering.test.tsx` | Added `setSystemPrompt` to agent mocks |
| `tests/cli/render-turn-content.test.tsx` | Added `setSystemPrompt` to agent mocks |

---

## Test Counts

| Stage | Tests | Status |
|-------|-------|--------|
| Baseline (main) | 208 passed | ✅ |
| After Step 1 | 238 passed | ✅ |
| After Step 2 | 255 passed | ✅ |
| After Review Fixes | 264 passed | ✅ |
| After SDK Migration | 259 passed + 1 skipped | ✅ |

**Delta: +51 tests** (208 → 259). One smoke test is skipped when QMD native dependencies are unavailable.

---

## SDK Migration Details

### Why SDK instead of CLI?

| Aspect | CLI (vorher) | SDK (jetzt) |
|--------|-------------|-------------|
| Model loading | Pro Aufruf (cold start) | Einmalig am Store (prozess-lebenslang) |
| JSON parsing | Manuell, fehleranfällig | Typisierte Rückgaben |
| Error handling | Exit codes + stderr | Exceptions |
| Collection setup | `execFile("qmd collection add")` | `store.addCollection()` |
| Write → Index | Caller muss `qmd update`/`embed` aufrufen | Inkrementell via `store.update()`/`embed()` |
| Gateway-ready | Nicht möglich (CLI-Prozess) | Natürlich (Store als Objekt) |

### Verifiziert vs. Angenommen (SDK-API)

| Annahme aus Plan | Echte SDK-Signatur (node_modules) | Status |
|---|---|---|
| `createStore({ dbPath, config: { collections: {...} } })` | `createStore(options: StoreOptions)` → `Promise<QMDStore>` | ✅ exakt so |
| `store.searchVector(query, { limit })` | `searchVector(query: string, options?: VectorSearchOptions)` → `Promise<SearchResult[]>` | ✅ exakt so |
| `store.search({ query, limit })` | `search(options: SearchOptions)` → `Promise<HybridQueryResult[]>` | ✅ exakt so |
| `store.addCollection(name, { path, pattern })` | `addCollection(name: string, opts: { path, pattern?, ignore? })` | ✅ exakt so |
| `store.listCollections()` | `listCollections()` → `Promise<{name, pwd, glob_pattern, doc_count, active_count, last_modified, includeByDefault}[]>` | ✅ exakt so |
| `store.update({ collections? })` | `update(options?: { collections?: string[], onProgress? })` → `Promise<UpdateResult>` | ✅ exakt so |
| `store.embed({ force?, collection? })` | `embed(options?: { force?, model?, collection?, ... })` → `Promise<EmbedResult>` | ✅ exakt so |
| `store.close()` | `close()` → `Promise<void>` | ✅ exakt so |
| Rückgabe `searchVector` hat `content` | Rückgabe hat `body?` + `title` | ⚠️ Mapping nutzt `body \|\| title` |
| Rückgabe `search` hat `content` | Rückgabe hat `body` + `bestChunk` + `title` | ⚠️ Mapping nutzt `bestChunk \|\| body \|\| title` |

**Keine weiteren Abweichungen.** Der Code folgt den echten SDK-Signaturen 1:1.

---

## QMD Smoke Test (manual)

QMD native dependencies may not be available in CI. A manual smoke test is recommended locally:

```bash
# 1. Ensure sqlite is available (macOS)
brew install sqlite

# 2. Install deps (includes @tobilu/qmd)
npm install

# 3. Optional: set German embed model
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"

# 4. Run the smoke test
npx vitest run tests/core/qmdSmoke.test.ts
```

---

## Post-Review Fixes

### 1. Project-Local Default Paths
- **Before:** Defaults were `~/memory`, `~/sources` (home directory).
- **After:** Defaults are now `<projectRoot>/memory`, `<projectRoot>/sources`.
- **Rationale:** All editable runtime files belong in the workspace, not scattered across the user's home directory. Enables project isolation and easy deployment.

### 2. Idempotent QMD Auto-Setup (SDK)
- **Before (CLI era):** `ensureQmdCollections()` called `qmd collection add` via `execFile` and parsed stderr for "already exists".
- **After (SDK era):** `MemoryService.ensureCollections()` calls `store.listCollections()` and `store.addCollection()` directly. No string matching, no subprocess overhead.
- **Idempotent:** Already-existing collections are detected via `listCollections()` and skipped cleanly.
- **Graceful degrade:** If `createStore()` fails (e.g. `sqlite-vec` missing), `degraded=true` is set and `getBackend()` returns `StubBackend`.

### 3. Real Smoke Test + SDK E2E
- **Smoke test:** `tests/core/qmdSmoke.test.ts` performs an end-to-end test against the real SDK (write → createStore → update → embed → searchVector/search → assert hit). Skipped with a clear message when native deps are unavailable.
- **Unit tests:** `memoryService.test.ts` and `qmdBackend.test.ts` use fully mocked/fake stores — no JSON fixtures needed anymore.

---

## Assumptions & Open Questions

1. **QMD embed model for German:** Set `QMD_EMBED_MODEL` env var before `createStore()`. First run with a new model triggers download (~500 MB for Qwen3 0.6B Q8). Re-embed with `force:true` required on model change.
2. **Startup latency:** `init()` calls `update()` + `embed()` on every boot. First run triggers ~2GB model download. This is synchronous/blocking in current code.
3. **App-Prop:** `memoryService` is injected into `<App />` but not yet used (reserved for Phase 2B/3 ambient retrieval).
4. **No automatic Stub fallback at tool level:** The backend interface is pluggable, but there is no auto-detection yet in a future Memory-Tool. Callers receive a `MemoryBackend` from `MemoryService.getBackend()`.
