# Cliffford V2

Custom agent loop built on top of `@mariozechner/pi-ai`.

## Quick Start

```bash
# Install dependencies
npm install

# Copy env template and fill in your keys
cp .env.example .env

# One-off run (no watch)
npx tsx src/index.ts

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

## Project Structure

```
src/
├── index.ts          # Entry point
├── core/             # Agent Loop
│   └── agent.ts
├── tools/            # Custom Tools (Read/Write/Edit/Exec + your own)
│   ├── types.ts
│   └── registry.ts
├── extensions/       # Notion, Baileys, Memory, etc.
└── utils/            # Shared helpers
```

## Memory Setup (optional)

Harness supports local markdown memory via [QMD](https://github.com/tobi/qmd). On startup, Harness automatically creates:

- `<projectRoot>/memory/` — your knowledge base
- `<projectRoot>/sources/` — reference material
- `<projectRoot>/memory/_inbox.md` — quick notes

If QMD is installed, collections are **auto-registered** and indexed on startup:

```bash
# Install Bun (prerequisite for QMD)
curl -fsSL https://bun.sh/install | bash

# Install QMD
bun install -g https://github.com/tobi/qmd
```

That's it — Harness handles `qmd collection add`, `qmd update`, and `qmd embed` automatically.

**First run:** `qmd embed` downloads ~2GB of local GGUF models (embedding + reranker). This happens once and is triggered automatically.

**Override paths:** Set `HARNESS_MEMORY_PATH`, `HARNESS_SOURCES_PATH`, or `HARNESS_INBOX_PATH` to customize locations.

If QMD is not installed, the memory backend gracefully falls back to a no-op stub.

## Architecture Decision

- **Only dependency:** `@mariozechner/pi-ai` (Multi-Provider-LLM-Layer)
- **Self-built:** Agent Loop, Tool Validation, Sessions, Persistence
