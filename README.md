# Harness

Custom agent loop built on top of `@mariozechner/pi-ai`.

## Quick Start

```bash
# Install dependencies
npm install

# Copy env template and fill in your keys
cp .env.example .env

# One-off run (no watch)
npx tsx src/index.tsx

# Run in dev mode (hot reload)
npm run dev

# Type-check without emitting
npm run typecheck

# Run tests
npm run test

# Build for production
npm run build
npm start
```

## Requirements

- **Node:** >= 20 (>= 22 recommended for native SQLite extensions used by QMD)
- **macOS:** `brew install sqlite` (required for `sqlite-vec`)

## Project Structure

```
src/
├── index.tsx         # Entry point
├── cli/              # TUI (Ink + React)
│   └── App.tsx
├── core/             # Agent Loop + Memory
│   ├── agent.ts
│   ├── memoryService.ts
│   └── qmdBackend.ts
├── tools/            # Custom Tools (Read/Write/Edit/Exec + your own)
│   ├── types.ts
│   └── registry.ts
├── extensions/       # Notion, Baileys, Memory, etc.
└── utils/            # Shared helpers
```

## Memory Setup (optional)

Harness supports local markdown memory via the [`@tobilu/qmd`](https://github.com/tobi/qmd) SDK. On startup, Harness automatically creates:

- `<projectRoot>/memory/` — your knowledge base
- `<projectRoot>/sources/` — reference material
- `<projectRoot>/memory/_inbox.md` — quick notes
- `<projectRoot>/.qmd/index.sqlite` — QMD search index

Collections are **auto-registered** and indexed on startup. No manual `qmd` CLI setup required.

**First run:** The SDK auto-downloads local GGUF models (~2 GB: embedding + reranker). This happens once during the first `embed` call and is triggered automatically on startup.

**German content:** The default embedder is English-optimized. For German or mixed DE/EN content, set before running:

```bash
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

**Override paths:** Set `HARNESS_MEMORY_PATH`, `HARNESS_SOURCES_PATH`, `HARNESS_INBOX_PATH`, or `HARNESS_QMD_DB_PATH` to customize locations.

If QMD native dependencies are unavailable (e.g. `sqlite-vec` missing), the memory backend gracefully falls back to a no-op stub — Harness continues to work without retrieval.

## Architecture Decision

- **Only dependency:** `@mariozechner/pi-ai` (Multi-Provider-LLM-Layer)
- **Self-built:** Agent Loop, Tool Validation, Sessions, Persistence
