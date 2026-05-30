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

Harness supports local markdown memory via [QMD](https://github.com/tobi/qmd). To enable it:

```bash
# Install Bun (prerequisite for QMD)
curl -fsSL https://bun.sh/install | bash

# Install QMD
bun install -g https://github.com/tobi/qmd

# Register collections (one-time)
qmd collection add ~/memory --name memory --mask "**/*.md"
qmd collection add ~/sources --name sources --mask "**/*.md"

# Build index (first run downloads ~2GB of local GGUF models)
qmd update
qmd embed
```

If QMD is not installed, the memory backend gracefully falls back to a no-op stub.

## Architecture Decision

- **Only dependency:** `@mariozechner/pi-ai` (Multi-Provider-LLM-Layer)
- **Self-built:** Agent Loop, Tool Validation, Sessions, Persistence
