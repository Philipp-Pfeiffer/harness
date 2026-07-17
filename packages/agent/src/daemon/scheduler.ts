import { watch, type FSWatcher } from "node:fs";

import { Cron } from "croner";

import { loadCronJobs, type CronJob } from "./jobs.js";
import { getScriptJob, type ScriptJobContext } from "./scripts.js";
import type { ComponentLogger } from "./logger.js";

/* ─── Cron Scheduler ───
 *
 * Loads job definitions from `$HARNESS_STATE/jobs/*.md`, schedules them
 * via croner and reloads them when the directory changes.
 *
 * Semantics:
 * - Disabled jobs are parsed but never scheduled.
 * - Each run is delayed by a random jitter in [0, job.jitterMs].
 * - Job errors are logged, never propagated — the daemon must not die.
 * - Missed runs are skipped: there is no catch-up for downtime, and a
 *   run pending in its jitter delay is dropped when the scheduler stops.
 * - Overlapping runs of the same job are prevented (croner `protect`).
 */

export interface CronSchedulerOptions {
  jobsDir: string;
  logger: ComponentLogger;
  /** Executes an agent-type job (creates the cron session + first turn). */
  runAgentJob: (job: CronJob) => Promise<void>;
  /** Context handed to script-type job functions. */
  scriptCtx: ScriptJobContext;
}

interface ScheduledJob {
  job: CronJob;
  cron: Cron;
}

/** Debounce for fs.watch events (editors often trigger several). */
const RELOAD_DEBOUNCE_MS = 200;

/**
 * Draws a random jitter delay in [0, maxMs]. Returns 0 when maxMs <= 0.
 */
export function randomJitterMs(
  maxMs: number,
  rand: () => number = Math.random,
): number {
  if (maxMs <= 0) return 0;
  return Math.floor(rand() * (maxMs + 1));
}

export class CronScheduler {
  private readonly jobsDir: string;
  private readonly logger: ComponentLogger;
  private readonly runAgentJob: (job: CronJob) => Promise<void>;
  private readonly scriptCtx: ScriptJobContext;

  /** Scheduled jobs, keyed by job file path. */
  private readonly scheduled = new Map<string, ScheduledJob>();
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingJitter = new Set<{
    timer: ReturnType<typeof setTimeout>;
    done: (proceed: boolean) => void;
  }>();
  private stopped = true;

  constructor(opts: CronSchedulerOptions) {
    this.jobsDir = opts.jobsDir;
    this.logger = opts.logger;
    this.runAgentJob = opts.runAgentJob;
    this.scriptCtx = opts.scriptCtx;
  }

  /** Loads jobs and starts watching the jobs directory for changes. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.reload();
    try {
      this.watcher = watch(this.jobsDir, () => this.scheduleReload());
    } catch (err) {
      // Jobs are loaded; only change-reload is unavailable.
      this.logger.error("failed to watch jobs dir — reload on change disabled", {
        dir: this.jobsDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Stops all jobs, the watcher and pending jitter delays. */
  stop(): void {
    this.stopped = true;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const entry of this.scheduled.values()) {
      entry.cron.stop();
    }
    this.scheduled.clear();
    for (const pending of this.pendingJitter) {
      clearTimeout(pending.timer);
      pending.done(false); // run pending in jitter is skipped, not caught up
    }
    this.pendingJitter.clear();
  }

  /**
   * Reloads job files from disk and reconciles the scheduled set:
   * new/changed files are (re)scheduled, removed files are stopped.
   */
  async reload(): Promise<void> {
    const { jobs, errors } = await loadCronJobs(this.jobsDir);
    for (const error of errors) {
      this.logger.error("job file invalid", { error });
    }
    if (this.stopped) return;

    const seen = new Set<string>();
    for (const job of jobs) {
      seen.add(job.filePath);
      const existing = this.scheduled.get(job.filePath);
      if (existing && sameJob(existing.job, job)) continue;
      if (existing) {
        existing.cron.stop();
        this.scheduled.delete(job.filePath);
      }
      if (!job.enabled) {
        this.logger.info("job disabled, not scheduled", { name: job.name });
        continue;
      }
      try {
        const cron = new Cron(job.schedule, { protect: true }, () => {
          void this.fire(job);
        });
        this.scheduled.set(job.filePath, { job, cron });
        this.logger.info("job scheduled", {
          name: job.name,
          type: job.type,
          schedule: job.schedule,
          jitterMs: job.jitterMs,
          nextRun: cron.nextRun()?.toISOString(),
        });
      } catch (err) {
        this.logger.error("job could not be scheduled", {
          name: job.name,
          schedule: job.schedule,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (const [filePath, entry] of [...this.scheduled]) {
      if (!seen.has(filePath)) {
        entry.cron.stop();
        this.scheduled.delete(filePath);
        this.logger.info("job unscheduled (file removed)", { name: entry.job.name });
      }
    }
  }

  /**
   * Executes one run of a job: applies the per-run jitter, then runs the
   * agent or script handler. Never throws — errors are logged.
   */
  private async fire(job: CronJob): Promise<void> {
    if (this.stopped) return;

    const delay = randomJitterMs(job.jitterMs);
    if (delay > 0) {
      const proceed = await this.jitterSleep(delay);
      if (!proceed || this.stopped) return; // stopped during jitter → skip run
    }

    const startedMs = Date.now();
    try {
      if (job.type === "agent") {
        await this.runAgentJob(job);
      } else {
        const fn = getScriptJob(job.body);
        if (!fn) {
          throw new Error(`unknown script job function: ${job.body}`);
        }
        await fn(this.scriptCtx);
      }
      this.logger.info("job run ok", {
        name: job.name,
        type: job.type,
        latencyMs: Date.now() - startedMs,
      });
    } catch (err) {
      this.logger.error("job run failed", {
        name: job.name,
        type: job.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Sleeps `ms`; resolves false when stop() aborts the pending delay. */
  private jitterSleep(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const pending: {
        timer: ReturnType<typeof setTimeout>;
        done: (proceed: boolean) => void;
      } = {
        timer: setTimeout(() => {
          this.pendingJitter.delete(pending);
          resolve(true);
        }, ms),
        done: resolve,
      };
      this.pendingJitter.add(pending);
    });
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.reload().catch((err) => {
        this.logger.error("job reload failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, RELOAD_DEBOUNCE_MS);
  }
}

function sameJob(a: CronJob, b: CronJob): boolean {
  return (
    a.name === b.name &&
    a.schedule === b.schedule &&
    a.enabled === b.enabled &&
    a.type === b.type &&
    a.jitterMs === b.jitterMs &&
    a.body === b.body
  );
}
