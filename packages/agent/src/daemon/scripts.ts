import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { HarnessPaths } from "@harness/core";

import { buildCuratorPingText } from "./curatorPing.js";
import type { ComponentLogger } from "./logger.js";

/* ─── Script Job Registry ───
 *
 * Internal registry for `type: script` cron jobs. The job file body names
 * a function registered here; the scheduler looks it up at fire time.
 * Unknown names are logged as job errors — the daemon keeps running.
 */

export interface ScriptJobContext {
  paths: HarnessPaths;
  logger: ComponentLogger;
  /** Retention in days for data managed by scripts (from daemon config). */
  retentionDays: number;
  /** Best-effort system event injection (used by curator-ping). */
  injectEvent?: (event: { origin: string; text: string }) => Promise<void> | void;
}

export type ScriptJobFn = (ctx: ScriptJobContext) => Promise<void>;

const registry = new Map<string, ScriptJobFn>();

export function registerScriptJob(name: string, fn: ScriptJobFn): void {
  registry.set(name, fn);
}

export function getScriptJob(name: string): ScriptJobFn | undefined {
  return registry.get(name);
}

/* ─── Built-in: metrics-rotation ───
 *
 * Deletes daily metric files (turns|tools|system-YYYY-MM-DD.jsonl) older
 * than the configured retention, mirroring the daemon log rotation.
 */

const METRICS_FILE_RE = /^(?:turns|tools|system)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

async function rotateMetrics(ctx: ScriptJobContext): Promise<void> {
  const cutoff = Date.now() - ctx.retentionDays * 24 * 60 * 60 * 1000;

  let files: string[];
  try {
    files = await readdir(ctx.paths.metrics);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // no metrics yet — nothing to rotate
    throw err;
  }

  let deleted = 0;
  for (const file of files) {
    const match = file.match(METRICS_FILE_RE);
    if (!match) continue;
    const fileDate = new Date(`${match[1]}T00:00:00Z`).getTime();
    if (fileDate < cutoff) {
      await unlink(join(ctx.paths.metrics, file));
      deleted++;
    }
  }

  ctx.logger.info("metrics rotation done", {
    deleted,
    retentionDays: ctx.retentionDays,
  });
}

registerScriptJob("metrics-rotation", rotateMetrics);

/* ─── Built-in: curator-ping ───
 *
 * After a curator stage-2 run, pings the WhatsApp session via the
 * system event bus. No report or empty report → no ping.
 */
registerScriptJob("curator-ping", async (ctx) => {
  const text = await buildCuratorPingText(ctx.paths.state, ctx.logger);
  if (!text) return;
  if (ctx.injectEvent) {
    await ctx.injectEvent({ origin: "Curator", text });
  } else {
    ctx.logger.info("curator ping skipped — no event bus available");
  }
});
