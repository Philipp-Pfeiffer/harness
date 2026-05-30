# Phase-2A Memory Foundation Integration Report

**Date:** 2026-05-30
**Integration Agent:** Kimi Code CLI
**Baseline HEAD:** `b2b486b` (208 tests green)
**Final HEAD:** `9e15443`

---

## Commits

1. `9a63514` — **feat(memory): core.md loaded into system prompt (Phase 2A Step 1)**
   - Adds `core.md` template, `src/core/coreMemory.ts` loader/parser, `setSystemPrompt` to Agent interface.
   - Integrates core memory injection into `src/cli/App.tsx`.
   - Adds `tests/core/coreMemory.test.ts` (8 tests).

2. `9e15443` — **feat(memory): markdown folders + QMD MemoryBackend adapter (Phase 2A Step 2)**
   - Adds `src/core/memoryFolders.ts` for idempotent `~/memory`, `~/sources`, `_inbox.md` creation.
   - Adds `MemoryBackend` interface, `QmdBackend` (QMD-CLI adapter), `StubBackend` (fallback).
   - Integrates folder scaffolding into `src/index.tsx` startup path.
   - Adds tests: `memoryFolders.test.ts` (4), `qmdBackend.test.ts` (10), `stubBackend.test.ts` (3).

3. *(this report)* — **docs(memory): architecture + change report for Phase 2A foundation**

---

## New Files

| File | Purpose |
|------|---------|
| `core.md` | User-maintainable identity/project context (injected into system prompt) |
| `src/core/coreMemory.ts` | Loader, parser, formatter, composer for core.md |
| `src/core/memoryFolders.ts` | Folder scaffolding with env-configurable paths |
| `src/core/memoryBackend.ts` | `MemoryBackend` interface + `MemoryHit` / `MemoryEntry` types |
| `src/core/qmdBackend.ts` | QMD-CLI adapter: `vsearch` (L2), `query` (L4), `write` |
| `src/core/stubBackend.ts` | No-op fallback implementing `MemoryBackend` |
| `tests/core/coreMemory.test.ts` | Unit tests for core memory loader/parser |
| `tests/core/memoryFolders.test.ts` | Unit tests for folder scaffolding |
| `tests/core/qmdBackend.test.ts` | Unit tests for QMD backend (mocked `execFile`) |
| `tests/core/stubBackend.test.ts` | Unit tests for stub fallback |
| `docs/architecture/memory.md` | Architecture overview for memory subsystem |
| `docs/changes/phase-2a-memory-foundation.md` | This report |

---

## Modified Files

| File | Change |
|------|--------|
| `src/core/agent.ts` | Added `setSystemPrompt` to `Agent` interface and `createAgent` return object |
| `src/cli/App.tsx` | Added core memory load effect; imports `coreMemory` + `prompts` |
| `src/index.tsx` | Added `ensureMemoryFolders()` call on startup |
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

**Delta: +47 tests** (208 → 255).

---

## QMD Smoke Test (manual)

QMD is an external dependency and not installed in CI. A manual smoke test is recommended:

```bash
# 1. Install QMD (requires Bun)
bun install -g https://github.com/tobi/qmd

# 2. Add collections
qmd collection add ~/memory --name memory --mask "**/*.md"
qmd collection add ~/sources --name sources --mask "**/*.md"

# 3. Build index
qmd update
qmd embed   # first run downloads GGUF models (~2GB total)

# 4. Test queries
qmd vsearch "project context" --json -n 5
qmd query "architecture decisions" --json -n 5
```

---

## Assumptions & Open Questions

1. **QMD binary path:** Default is `"qmd"` (PATH lookup). Override via `QmdBackendOptions.binaryPath`.
2. **QMD collections:** The backend does not auto-register collections. This is deferred to Step 3/4 or manual setup.
3. **QMD JSON shape:** The parser handles both direct arrays and `{ results: [...] }` wrappers, based on observed QMD behavior. If QMD changes its JSON schema, the parser needs updating.
4. **First-Run model download:** QMD auto-downloads GGUF models on first `embed`/`vsearch`/`query`. This is handled by QMD internally; Harness only calls the CLI.
5. **No automatic Stub fallback:** The backend interface is pluggable, but there is no auto-detection yet (e.g., "QMD missing → use Stub"). Callers must instantiate the backend they want.
