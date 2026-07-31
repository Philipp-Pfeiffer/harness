# Harness

Custom agent loop built on [`@mariozechner/pi-ai`](https://github.com/mariozechner/pi-ai).

Multi-provider LLM agent with persistent daemon, interactive TUI, context compaction, channel-aware output pipeline, and local markdown memory.

## Quick Start

```bash
# Install dependencies (pnpm workspace)
pnpm install

# Copy env template and fill in your provider keys
cp .env.example .env

# Build both packages
pnpm -r build

# Start the daemon (persistent background process)
harness daemon start

# Launch the TUI (connects to daemon)
harness chat

# Or run the in-process TUI without daemon
harness
```

## Requirements

- **Node:** >= 20 (>= 22 recommended for native SQLite extensions used by QMD)
- **pnpm:** >= 9
- **Linux:** `sqlite3` dev headers (for `sqlite-vec` via QMD)

## Monorepo Layout

```
packages/
├── core/                # @harness/core — reusable agent loop (no TTY/CLI deps)
│   ├── src/
│   │   ├── core/        # Agent loop, compaction, metrics, mailbox
│   │   ├── tools/        # readFile, exec, write, edit, web_search, web_fetch
│   │   ├── config/      # paths.ts (single source of truth), config loader
│   │   └── prompts/     # System prompt, compaction prompt, steer annotations
│   └── tests/
└── agent/               # @harness/agent — daemon, TUI, CLI, output pipeline
    ├── src/
    │   ├── index.tsx     # CLI entry point + subcommand dispatch
    │   ├── cli/          # TUI (Ink + React), help text
    │   ├── daemon/       # Runtime, IPC, logger, session management
    │   ├── backends/     # InProcessBackend, DaemonClientBackend
    │   ├── output/       # AST-based channel output pipeline
    │   └── core/        # Memory service, session, system prompt builder
    └── tests/
```

## CLI Commands

```
harness                    Start interactive TUI (in-process agent loop)
harness chat               Connect to daemon and launch TUI with session picker
harness daemon start       Start daemon as detached background process
harness daemon stop        Stop running daemon
harness daemon restart     Stop + start
harness daemon status      Show PID, uptime, model, sessions, last errors
harness daemon install     Install systemd user service unit
harness daemon logs        Show last 100 lines of daemon logs
harness sessions           List all sessions (via daemon IPC)
harness send "message"     Send a single message to a session
harness render --channel <c> <file.md>   Render markdown for a channel
harness reload-config      Hot-reload daemon config without restart
harness migrate-home       Migrate legacy substrate to $HARNESS_HOME
harness help               Show command overview
```

### TUI Slash Commands

| Command | Action |
|---------|--------|
| `/new` | End current session, start a new one |
| `/sessions` | List all sessions |
| `/resume <id>` | Resume a specific session |
| `/end` | End the current session |
| `/compact` | Manually trigger context compaction |
| `/clear` | Clear the TUI display |
| `/model` | Switch model (in-process mode) |
| `/status` | Show harness status overview |
| `/help` | Show slash commands and keybinds |
| `/quit` | Exit the TUI |

## Runtime Topology

Harness separates durable agent knowledge from ephemeral machine state:

| Category | Path | Contents | Git? |
|----------|------|----------|------|
| **HOME** (durable) | `$HARNESS_HOME` (default `~/harness`) | `core.md`, `AGENTS.md`, `config.json`, `memory/`, `sources/`, `skills/` | Own repo |
| **STATE** (ephemeral) | `$HARNESS_STATE` (default `~/.harness`) | `sessions/`, `metrics/`, `index/`, `logs/`, `daemon.pid`, `daemon.sock` | No |
| **CODE** | Repo | `packages/`, `docs/`, `tests/` | Yes |

HOME is portable and shared across agent processes. STATE is regenerable — `harness reindex` rebuilds the index.

**Environment overrides:** `HARNESS_HOME`, `HARNESS_STATE`, `XDG_STATE_HOME`.

## Daemon

The daemon (`harness daemon start`) runs as a persistent background process. CLI/TUI clients connect via Unix socket at `$HARNESS_STATE/daemon.sock` (newline-delimited JSON protocol).

Features:
- **Session management** — create, resume, list, end sessions with transcript persistence
- **Slash commands** — daemon-side interpretation works identically across all gateways (TUI, WhatsApp, etc.)
- **Auto-compaction** — when the message context exceeds 80% of the model's context window, the oldest turns are summarized via LLM and the full history is written to an alt-context file
- **`/compact`** — manually trigger compaction, returns token count before/after and alt-context path
- **Hot-reload** — `harness reload-config` updates memory settings, log retention, and heartbeat interval without restart
- **systemd** — `harness daemon install` generates a user service unit with `Restart=on-failure`

Config is an optional `"daemon"` key inside `config.json`:

```json
{
  "models": [...],
  "providers": {...},
  "defaultModel": {...},
  "daemon": {
    "memory": { "ambientHints": true, "maxHints": 5 },
    "logRetentionDays": 14,
    "heartbeatIntervalSec": 0
  }
}
```

## Output Pipeline

Channel-aware rendering (`packages/agent/src/output/`) transforms markdown into channel-appropriate output:

- **Channels:** `whatsapp`, `discord`, `signal`, `mail` — each with length limits and capability profiles
- **AST-based:** markdown is parsed to a canonical AST, then rendered per channel
- **Table fallback chain:** monospace → image (PNG via satori+resvg) → linearized text, based on channel capabilities and table width
- **CLI:** `harness render --channel whatsapp file.md` renders a markdown file for a specific channel

```bash
harness render --channel discord README.md
```

## Context Compaction

When the conversation grows beyond 80% of the model's context window, Harness automatically:

1. Finds a split point (preserves the last ~20% of messages verbatim)
2. Writes the full uncompacted history to `$HARNESS_STATE/compaction/<sessionId>.md`
3. Calls the LLM with a dedicated compaction prompt to generate a summary
4. Replaces old messages with the summary + preserved recent tail

The agent can retrieve details from the alt-context file via `readFile`. Manual trigger: `/compact`.

## Memory (optional)

Harness supports local markdown memory via the [`@tobilu/qmd`](https://github.com/tobi/qmd) SDK. On startup, Harness automatically creates:

- `$HARNESS_HOME/memory/` — your knowledge base
- `$HARNESS_HOME/sources/` — reference material
- `$HARNESS_HOME/memory/_inbox.md` — quick notes
- `$HARNESS_STATE/index/index.sqlite` — QMD search index

Collections are **auto-registered** and indexed on startup. No manual `qmd` CLI setup required.

**First run:** The SDK auto-downloads local GGUF models (~2 GB: embedding + reranker). This happens once during the first `embed` call.

**German content:** For German or mixed DE/EN content, set:

```bash
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

If QMD native dependencies are unavailable (e.g. `sqlite-vec` missing), the memory backend gracefully falls back to a no-op stub.

## Configuration

Provider keys and model config live in `$HARNESS_HOME/config.json`. API keys can be referenced via `env:VAR_NAME` indirection:

```json
{
  "models": [
    {
      "provider": "minimax",
      "name": "MiniMax-M2.7",
      "apiKey": "env:MINIMAX_API_KEY",
      "contextWindow": 1000000
    }
  ],
  "defaultModel": { "provider": "minimax", "name": "MiniMax-M2.7" },
  "providers": {
    "openai": {
      "custom": {
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "env:CUSTOM_API_KEY"
      }
    }
  }
}
```

Load `.env` from `$HARNESS_HOME/.env` (production) or `./.env` (dev override).

## Tools

Built-in tools (in `@harness/core`):

| Tool | Description |
|------|-------------|
| `readFile` | UTF-8 text + PDF extraction, line ranges, 64KB limit |
| `exec` | CLI command execution with No-Fly-List, timeout, background mode |
| `write` | Atomic file writes with sensitive-path protection |
| `edit` | Find-and-replace with read-tracking validation |
| `process` | Background process lifecycle (list, poll, kill, log) |
| `web_search` | Multi-provider web search with fallback |
| `web_fetch` | URL fetcher with content safety filtering |
| `browser` | Delegates to a browser sub-agent (CDP/Obscura) for JS-rendered pages |

## Browser Subsystem

The main agent gets a single `browser` tool that spawns a dedicated browser sub-agent. The sub-agent operates a real browser via CDP and returns a structured report.

### Setup (Obscura)

Install Obscura once:

```bash
# Arch Linux
yay -S obscura-browser
```

Harness **spawns Obscura automatically** when the `browser` tool runs and **stops it when the session ends**. No manual `obscura serve` required.

Optional: attach to an already-running CDP server for debugging with `"mode": "cdp"`.

### Configuration

`$HARNESS_HOME/config.json`:

```json
{
  "browser": {
    "mode": "obscura",
    "model": "@preset/deepseek-flash",
    "obscuraPath": "obscura",
    "obscuraStartupTimeoutMs": 15000,
    "maxTurns": 25,
    "maxTokens": 4096,
    "maxTotalTokens": 80000,
    "snapshotTokenCap": 8000,
    "navigationTimeoutMs": 30000,
    "actionTimeoutMs": 15000,
    "maxTabs": 5,
    "maxDownloadBytes": 52428800
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `mode` | `obscura` | `obscura` = managed spawn/teardown per session. `cdp` = external CDP only. |
| `obscuraPath` | `obscura` | Binary path. Override with `OBSCURA_PATH` env. |
| `cdpUrl` | `http://127.0.0.1:9222` | Only used when `mode` is `cdp`. |

Environment overrides: `OBSCURA_PATH`, `BROWSER_CDP_URL` (cdp mode only).

Downloads are stored under `$HARNESS_STATE/downloads/<session-id>/` (non-executable, magic-byte verified).

### Integration tests

```bash
# Requires Obscura installed (obscura on PATH or OBSCURA_PATH)
BROWSER_INTEGRATION=1 pnpm --filter @harness/core test tests/browser
```

## Development

```bash
# Install + build
pnpm install && pnpm -r build

# Run tests (CI mode — no watch)
CI=true pnpm -r test

# Dev mode (hot reload)
pnpm --filter @harness/agent dev

# Type-check only
pnpm -r typecheck
```

## Architecture

- **Only framework dependency:** `@mariozechner/pi-ai` (multi-provider LLM layer)
- **Self-built:** Agent loop, tool validation, sessions, persistence, daemon, TUI, output pipeline, compaction
- **TypeScript strict:** `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`
- **ESM-only** — no CommonJS
- **Path resolution:** Single source of truth in `packages/core/src/config/paths.ts`

Detailed docs in `docs/` — tool docs in `docs/tools/`, architecture in `docs/architecture/`.
