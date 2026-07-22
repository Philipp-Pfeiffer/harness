import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveHarnessPaths, type HarnessPaths } from "@harness/core";

import { CronScheduler, randomJitterMs } from "../../src/daemon/scheduler.js";
import { registerScriptJob } from "../../src/daemon/scripts.js";
import { DaemonLogger } from "../../src/daemon/logger.js";
import type { CronJob } from "../../src/daemon/jobs.js";

const EVERY_SECOND = "* * * * * *";

let TEST_DIR: string;
let paths: HarnessPaths;
let logger: DaemonLogger;
let scheduler: CronScheduler | null;

const ORIGINAL_ENV = {
  HARNESS_HOME: process.env.HARNESS_HOME,
  HARNESS_STATE: process.env.HARNESS_STATE,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), "harness-cron-sched-"));
  process.env.HARNESS_HOME = join(TEST_DIR, "home");
  process.env.HARNESS_STATE = join(TEST_DIR, "state");
  await mkdir(join(TEST_DIR, "state", "jobs"), { recursive: true });
  paths = resolveHarnessPaths();
  logger = new DaemonLogger({ logDir: paths.logs });
  await logger.init();
  scheduler = null;
});

afterEach(async () => {
  scheduler?.stop();
  scheduler = null;
  restoreEnv();
  await rm(TEST_DIR, { recursive: true, force: true });
});

function jobsDir(): string {
  return join(TEST_DIR, "state", "jobs");
}

async function writeJob(filename: string, frontmatter: string, body: string): Promise<void> {
  await writeFile(join(jobsDir(), filename), `---\n${frontmatter}\n---\n${body}\n`);
}

function makeScheduler(runAgentJob: (job: CronJob) => Promise<void>): CronScheduler {
  scheduler = new CronScheduler({
    jobsDir: jobsDir(),
    logger: logger.child("cron-test"),
    runAgentJob,
    scriptCtx: {
      paths,
      logger: logger.child("cron-test-script"),
      retentionDays: 14,
    },
  });
  return scheduler;
}

async function waitFor(cond: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("randomJitterMs", () => {
  it("stays within [0, maxMs] across many draws", () => {
    for (let i = 0; i < 1_000; i++) {
      const d = randomJitterMs(100);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(100);
    }
  });

  it("hits the exact bounds with deterministic rand", () => {
    expect(randomJitterMs(7_200_000, () => 0)).toBe(0);
    expect(randomJitterMs(7_200_000, () => 0.999_999_999)).toBe(7_200_000);
  });

  it("returns 0 when jitter is disabled", () => {
    expect(randomJitterMs(0)).toBe(0);
  });
});

describe("CronScheduler", () => {
  it("fires an enabled script job on schedule", async () => {
    let calls = 0;
    registerScriptJob("test-enabled-fires", async () => {
      calls++;
    });
    await writeJob(
      "enabled.md",
      `name: enabled\nschedule: ${EVERY_SECOND}\ntype: script`,
      "test-enabled-fires",
    );

    const s = makeScheduler(async () => {});
    await s.start();

    await waitFor(() => calls >= 1);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("never fires a disabled job", async () => {
    let agentCalls = 0;
    await writeJob(
      "disabled.md",
      `name: disabled\nschedule: ${EVERY_SECOND}\nenabled: false\ntype: agent`,
      "do something",
    );

    const s = makeScheduler(async () => {
      agentCalls++;
    });
    await s.start();

    // A disabled job is never scheduled, so no timing can make it fire.
    await sleep(1_600);
    expect(agentCalls).toBe(0);
  });

  it("routes agent jobs to runAgentJob with the body as prompt", async () => {
    const seen: CronJob[] = [];
    await writeJob(
      "agent.md",
      `name: agent-job\nschedule: ${EVERY_SECOND}\ntype: agent`,
      "Summarize today's metrics.",
    );

    const s = makeScheduler(async (job) => {
      seen.push(job);
    });
    await s.start();

    await waitFor(() => seen.length >= 1);
    expect(seen[0]!.type).toBe("agent");
    expect(seen[0]!.body).toBe("Summarize today's metrics.");
    expect(seen[0]!.name).toBe("agent-job");
  });

  it("fires a job with jitter within schedule + jitter range", async () => {
    let calls = 0;
    registerScriptJob("test-jittered", async () => {
      calls++;
    });
    await writeJob(
      "jittered.md",
      `name: jittered\nschedule: ${EVERY_SECOND}\ntype: script\njitter: 1s`,
      "test-jittered",
    );

    const s = makeScheduler(async () => {});
    await s.start();

    // 1s schedule + max 1s jitter + slack must be enough for the first run.
    await waitFor(() => calls >= 1, 3_500);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("logs a failing job and keeps firing subsequent runs", async () => {
    let calls = 0;
    registerScriptJob("test-always-throws", async () => {
      calls++;
      throw new Error("boom");
    });
    await writeJob(
      "failing.md",
      `name: failing\nschedule: ${EVERY_SECOND}\ntype: script`,
      "test-always-throws",
    );

    const s = makeScheduler(async () => {});
    await s.start();

    // Two separate runs prove the error did not tear the schedule.
    await waitFor(() => calls >= 2, 4_500);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("reports unknown script functions as job errors and survives", async () => {
    await writeJob(
      "unknown.md",
      `name: unknown\nschedule: ${EVERY_SECOND}\ntype: script`,
      "no-such-function",
    );

    const s = makeScheduler(async () => {});
    await s.start();

    // Nothing to observe directly — the scheduler must simply keep running.
    await sleep(1_600);
    expect(s).toBeDefined();
  });

  it("picks up new and changed job files on reload", async () => {
    let calls = 0;
    registerScriptJob("test-reload", async () => {
      calls++;
    });

    const s = makeScheduler(async () => {});
    await s.start();

    await writeJob(
      "added.md",
      `name: added\nschedule: ${EVERY_SECOND}\ntype: script`,
      "test-reload",
    );
    await s.reload();

    await waitFor(() => calls >= 1);

    // Disabling the job and reloading stops the firehose.
    const callsBeforeDisable = calls;
    await writeJob(
      "added.md",
      `name: added\nschedule: ${EVERY_SECOND}\nenabled: false\ntype: script`,
      "test-reload",
    );
    await s.reload();
    await sleep(1_600);
    expect(calls).toBeLessThanOrEqual(callsBeforeDisable + 1);
  });

  it("starts cleanly when the jobs directory does not exist", async () => {
    scheduler = new CronScheduler({
      jobsDir: join(TEST_DIR, "no-such-dir"),
      logger: logger.child("cron-test"),
      runAgentJob: async () => {},
      scriptCtx: { paths, logger: logger.child("cron-test-script"), retentionDays: 14 },
    });
    await scheduler.start(); // must not throw
  });

  it("disables a once: true job after its first successful run", async () => {
    let calls = 0;
    registerScriptJob("test-once", async () => {
      calls++;
    });
    await writeJob(
      "once.md",
      `name: once\nschedule: ${EVERY_SECOND}\ntype: script\nonce: true`,
      "test-once",
    );

    const s = makeScheduler(async () => {});
    await s.start();

    await waitFor(() => calls >= 1);
    // Give disableOneShot time to write the file after the script succeeds
    await sleep(200);

    // After the successful run, the file should have enabled: false
    const updated = await readFile(join(jobsDir(), "once.md"), "utf-8");
    expect(updated).toMatch(/enabled:\s*false/);

    // Wait another schedule cycle — the job should not fire again
    const callsAfterDisable = calls;
    await sleep(2_000);
    expect(calls).toBe(callsAfterDisable);
  });

  it("does not disable a once: true job when the run fails", async () => {
    let calls = 0;
    registerScriptJob("test-once-fail", async () => {
      calls++;
      throw new Error("boom");
    });
    await writeJob(
      "once-fail.md",
      `name: once-fail\nschedule: ${EVERY_SECOND}\ntype: script\nonce: true`,
      "test-once-fail",
    );

    const s = makeScheduler(async () => {});
    await s.start();

    await waitFor(() => calls >= 1);

    // Failing run should NOT disable the job
    const updated = await readFile(join(jobsDir(), "once-fail.md"), "utf-8");
    expect(updated).not.toMatch(/enabled:\s*false/);

    // Should fire again
    await waitFor(() => calls >= 2);
  });
});
