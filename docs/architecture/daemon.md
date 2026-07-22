# Daemon / Persistent Runtime Mode

**Stand:** 2026-07-22 · **Files:** `packages/agent/src/daemon/` (types.ts, logger.ts, process.ts, ipc.ts, runtime.ts, commands.ts, systemd.ts, jobs.ts, scheduler.ts, scripts.ts)

## CLI Commands

```
harness daemon start     — Start daemon as detached background process
harness daemon stop      — Stop daemon (SIGTERM, then SIGKILL after 10s)
harness daemon restart   — Stop + start
harness daemon status    — Show PID, uptime, model, gateways, last errors
harness daemon install   — Generate and install systemd user service unit
harness daemon run       — Internal: run the daemon process (spawned by `start`)
harness reload-config    — Hot-reload daemon config without restart
```

## Config

Daemon config is an optional `"daemon"` key inside the existing `config.json`:

```json
{
  "models": [...],
  "providers": {...},
  "defaultModel": {...},
  "daemon": {
    "gateways": [],
    "skills": [],
    "memory": { "ambientHints": true, "maxHints": 5 },
    "logRetentionDays": 14,
    "heartbeatIntervalSec": 0,
    "whatsapp": {
      "testMode": false,
      "phoneNumber": "4915112345678"
    }
  }
}
```

WhatsApp gateway is enabled by adding `"whatsapp"` to the `gateways` array. The `whatsapp` block is optional but required when the gateway is enabled — see [docs/architecture/whatsapp-gateway.md](whatsapp-gateway.md).

**Hot-reloadable (via `harness reload-config`):** `memory.ambientHints`, `memory.maxHints`, `logRetentionDays`, `heartbeatIntervalSec`.

**Requires daemon restart:** `defaultModel`, `providers`, `models` (model list changes), adding/removing gateways.

## Logging

Structured JSON-lines logs go to `$HARNESS_STATE/logs/daemon-YYYY-MM-DD.log`. Daily rotation is implicit (new date → new file). Retention cleanup runs on init and on date-boundary crossings, deleting files older than `logRetentionDays`.

## IPC

CLI/TUI clients connect to the daemon via Unix socket at `$HARNESS_STATE/daemon.sock`. Wire protocol: newline-delimited JSON. Request types: `ping`, `status`, `create-session`, `list-sessions`, `submit-turn`, `resume-session`, `end-session`, `reload-config`, `shutdown`.

## Channel Plugins & Gateways

External transports (WhatsApp, Telegram, etc.) implement the `ChannelPlugin` interface, which extends `GatewayAdapter` with structured outbound sending:

```typescript
interface GatewayAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<boolean>;
  onInbound(handler: (message: InboundMessage) => void): void;
}

interface ChannelPlugin extends GatewayAdapter {
  readonly channel: string;                                              // "whatsapp", "discord", ...
  sendMessage(target: string, payload: ChannelSendPayload): Promise<void>;
  getFileCapabilities?(): ChannelFileCapabilities;                       // MIME support, sticker, maxFileSize
}
```

Plugins are registered via `DaemonRuntime.registerGateway()` and held in a `channelPlugins` map. `initGateways()` is called during `start()` and iterates `config.gateways` to instantiate plugins. WhatsApp is the first implementation — see [docs/architecture/whatsapp-gateway.md](whatsapp-gateway.md).

**Inbound flow:** Plugin emits `ChannelInboundEvent` → daemon resolves/creates a persistent session per source (phone number) → `submitWhatsAppTurn()` hands it to the agent loop with image blocks + annotations.

**Outbound flow:** Agent response → `sendAgentResponse()` → `renderToChannel(markdown, "whatsapp")` → chunks + attachments sent sequentially via `plugin.sendMessage()` with 500ms delay (anti-ban).

**send_file Tool:** The agent can proactively send files via `send_file` tool → `channelFileSender` callback → `plugin.sendMessage()` with `{ files: [{ path, mimeType, caption }] }`. Channel-aware: rejects if the channel doesn't support the file type or no channel context exists.

## Heartbeat Hook

`DaemonRuntime.registerHeartbeat(hook)` accepts periodic health checks.

## Cron Scheduler

**Files:** `packages/agent/src/daemon/` (jobs.ts, scheduler.ts, scripts.ts)

Job files live in `$HARNESS_STATE/jobs/*.md` — Markdown with frontmatter (`name`, `schedule`, `enabled`, `type: agent|script`, optional `jitter` like `"2h"`, optional `agent` profile name, optional `once: true`); the body is the prompt (`agent`) or the registry function name (`script`).

```
---
name: metrics-rotation
schedule: 0 3 * * *
enabled: true
type: script
jitter: 2h
---
metrics-rotation
```

- `CronScheduler` (scheduler.ts) uses **croner**: loads jobs on daemon start, reloads on directory changes (`fs.watch`, debounced), draws a random per-run delay in `[0, jitterMs]`.
- `type: agent` runs `DaemonRuntime.runCronAgentJob()`: new session with `origin: "cron"`, body as first turn (via the internal IPC path — same turn queue, transcript and metrics as any session). The optional `agent` frontmatter field selects the agent profile for the session (default: `default`).
- `type: script` looks up the body in the internal registry (scripts.ts). Built-in example: `metrics-rotation` (deletes metric files older than `logRetentionDays`).
- `once: true` — Job deaktiviert sich nach dem ersten erfolgreichen Run selbst (`enabled: false` im Frontmatter). Bei Fehlern bleibt der Job aktiv.
- Robustness: job errors are logged, never thrown; no catch-up for missed runs; overlapping runs of one job are blocked (croner `protect`).

## Agent-Profile

**Files:** `packages/core/src/profiles/` (types.ts, frontmatter.ts, loader.ts), `packages/agent/agents/<name>/agent.md` (Built-in), `$HARNESS_HOME/agents/<name>/agent.md` (User)

Profile bestimmen System-Prompt, Modell/Thinking und Tool-Allowlist einer Session. User-Profile überschreiben Built-ins bei Namensgleichheit (wie bei Skills).

```
---
name: distillation
model: minimax/MiniMax-M2.7
thinking: true
tools: readFile, exec
memory: core, notes
skills: false
temperature: 0.7
maxTokens: 4096
---
Persona-Prompt …
```

- Frontmatter (alle außer `name` optional): `model` (`provider/model-id`), `thinking`, `tools` (Allowlist; absent = alle), `memory` (Zonen `core`|`notes`; absent = alle; `search_memory` + Ambient Hints brauchen `notes`), `skills` (Hot-Set-Block im Prompt, Default true), `temperature`/`maxTokens`.
- Body = Persona. Finaler Prompt: `base-prompt.md` (bare Runtime-Konventionen) + Persona + `<core_memory>` (Zone `core`) + Skill-Hot-Set (`skills: true`).
- Loader (`loadAgentProfiles`): validiert, sammelt Fehler, wirft nie. Built-in-Profile: `default` (bisheriger Main-Agent-Prompt) und `distillation` (Stub).
- IPC `create-session` nimmt optional `profile: <name>`; unbekanntes Profil → sauberer `error`-Response. Das Profil wird im Session-Index persistiert und beim Resume wiederhergestellt.
- Pro Profil wird lazily ein eigener Agent (Prompt, Modell, Tool-Subset) erzeugt und gecacht; Sessions ohne Profilangabe laufen exakt wie bisher über den Shared-Agent des `default`-Profils.

## Metrics

New events in `system-*.jsonl` (type: `"daemon"`): `daemon_start`, `daemon_stop`, `daemon_crash_restart`, `config_reload`. Stale PID file detection on startup triggers `daemon_crash_restart`.

## systemd Deployment

`harness daemon install` writes `~/.config/systemd/user/harness-daemon.service` with `Restart=on-failure`, `RestartSec=5`, and `WantedBy=default.target`. Enable with:

```
systemctl --user daemon-reload
systemctl --user enable harness-daemon
systemctl --user start harness-daemon
```
