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
├── core/             # Agent Loop, Context, Session
│   ├── agent.ts
│   ├── context.ts
│   └── session.ts
├── tools/            # Custom Tools (Read/Write/Edit/Bash + your own)
│   ├── types.ts
│   └── registry.ts
├── extensions/       # Notion, Baileys, Memory, etc.
└── utils/            # Shared helpers
```

## Architecture Decision

- **Only dependency:** `@mariozechner/pi-ai` (Multi-Provider-LLM-Layer)
- **Self-built:** Agent Loop, Tool Validation, Sessions, Persistence
