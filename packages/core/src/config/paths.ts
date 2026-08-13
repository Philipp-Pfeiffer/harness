import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

export interface HarnessPaths {
  /** Durables Agent-Substrat (portabel, git-trackbar). */
  home: string;
  /** Ephemerer, maschinen-lokaler State (regenerierbar). */
  state: string;
  /** $home/core.md */
  core: string;
  /** $home/AGENTS.md */
  agents: string;
  /** $home/config.json */
  config: string;
  /** $home/memory/ */
  memory: string;
  /** $home/memory/_inbox.md */
  inbox: string;
  /** $home/sources/ */
  sources: string;
  /** $home/skills/ */
  skills: string;
  /** $home/agents/ — Agent-Profile (Markdown mit Frontmatter) */
  agentProfiles: string;
  /** $state/sessions/ */
  sessions: string;
  /** $state/metrics/ */
  metrics: string;
  /** $state/index/ */
  index: string;
  /** $state/logs/ */
  logs: string;
  /** $state/jobs/ — Cron-Job-Definitionen (Markdown mit Frontmatter) */
  jobs: string;
  /** $state/inbound-media/ — Heruntergeladene Media-Dateien von Gateways */
  inboundMedia: string;
  /** $state/browser-runs/ — JSONL traces for browser sub-agent runs */
  browserRuns: string;
  /** $state/agent-runs/ — result.json artifacts for sub-agent runs */
  agentRuns: string;
  /** $state/whatsapp/ — Baileys Session-Persistence und Auth-State */
  whatsapp: string;
  /** $state/stickers/ — Sticker-Library (index.json + WebP-Dateien) */
  stickers: string;
  /** $state/stickers/incoming/ — unbekannte, empfangene Sticker */
  stickersIncoming: string;
  /** $state/daemon.pid */
  pidFile: string;
  /** $state/daemon.sock */
  socketFile: string;
  /** $state/voice.sock — Voice-Adapter IPC (NDJSON, siehe docs/voice-ipc.md). */
  voiceSocketFile: string;
  /** $home/voice-registry.json — Outbound-Call-Registry (fail-closed Allowlist). */
  voiceRegistry: string;
  /** $state/voice-ratelimit.json — Outbound-Call-Rate-Limit-Persistenz. */
  voiceRatelimit: string;
}

/**
 * Resolves HarnessPaths from explicit options, environment variables, or defaults.
 *
 * Resolution order:
 * - home: opts.home → $HARNESS_HOME → default ~/harness
 * - state: opts.state → $HARNESS_STATE → $XDG_STATE_HOME/harness → default ~/.harness
 *
 * Designed for dependency injection: create once at process startup and pass down.
 * Tests can inject a temp directory via `opts.home`/`opts.state` to stay fully isolated.
 */
export function resolveHarnessPaths(opts?: { home?: string; state?: string }): HarnessPaths {
  const home =
    opts?.home ?? process.env.HARNESS_HOME ?? path.join(os.homedir(), "harness");

  const state =
    opts?.state ??
    process.env.HARNESS_STATE ??
    (process.env.XDG_STATE_HOME
      ? path.join(process.env.XDG_STATE_HOME, "harness")
      : path.join(os.homedir(), ".harness"));

  return {
    home,
    state,
    core: path.join(home, "core.md"),
    agents: path.join(home, "AGENTS.md"),
    config: path.join(home, "config.json"),
    memory: path.join(home, "memory"),
    inbox: path.join(home, "memory", "_inbox.md"),
    sources: path.join(home, "sources"),
    skills: path.join(home, "skills"),
    agentProfiles: path.join(home, "agents"),
    sessions: path.join(state, "sessions"),
    metrics: path.join(state, "metrics"),
    index: path.join(state, "index"),
    logs: path.join(state, "logs"),
    jobs: path.join(state, "jobs"),
    inboundMedia: path.join(state, "inbound-media"),
    browserRuns: path.join(state, "browser-runs"),
    agentRuns: path.join(state, "agent-runs"),
    whatsapp: path.join(state, "whatsapp"),
    stickers: path.join(state, "stickers"),
    stickersIncoming: path.join(state, "stickers", "incoming"),
    pidFile: path.join(state, "daemon.pid"),
    socketFile: path.join(state, "daemon.sock"),
    voiceSocketFile: path.join(state, "voice.sock"),
    voiceRegistry: path.join(home, "voice-registry.json"),
    voiceRatelimit: path.join(state, "voice-ratelimit.json"),
  };
}

/**
 * Idempotently creates all Harness subdirectories.
 * Safe to call on every startup.
 */
export async function ensureDirs(paths: HarnessPaths): Promise<void> {
  await mkdir(paths.memory, { recursive: true });
  await mkdir(paths.sources, { recursive: true });
  await mkdir(paths.skills, { recursive: true });
  await mkdir(paths.agentProfiles, { recursive: true });
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.metrics, { recursive: true });
  await mkdir(paths.index, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
  await mkdir(paths.jobs, { recursive: true });
  await mkdir(paths.inboundMedia, { recursive: true });
  await mkdir(paths.browserRuns, { recursive: true });
  await mkdir(paths.agentRuns, { recursive: true });
  await mkdir(paths.whatsapp, { recursive: true });
  await mkdir(paths.stickers, { recursive: true });
  await mkdir(paths.stickersIncoming, { recursive: true });
}
