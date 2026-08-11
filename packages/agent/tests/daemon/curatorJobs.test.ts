/**
 * Validates the curator pipeline job files (frontmatter contract):
 * disabled until manual rollout, cron every-2-days at night,
 * staggered after distillation-daily, agent profiles referenced
 * exactly by their repo profile names.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { parseCronJobFile, loadCronJobs } from "../../src/daemon/jobs.js";
import { loadAgentProfiles } from "@harness/core";

const JOB_FILES = [
  "curator-stage1.md",
  "curator-stage2.md",
  "curator-ping.md",
] as const;

const PROFILES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../agents");
// Fixtures live at repo-root .harness/jobs — tests run from packages/agent.
const JOB_FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.harness/jobs");
let TEST_DIR: string;

beforeEach(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), "harness-curator-jobs-"));
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

function jobFixtures(): string[] {
  return JOB_FILES.map((f) =>
    parseCronJobFile(join(JOB_FIXTURES_DIR, f), readFileSync(join(JOB_FIXTURES_DIR, f), "utf-8")),
  );
}

function readFileSync(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync(p, "utf-8");
}

function copyJobFixtures(): void {
  for (const file of JOB_FILES) {
    void writeFile(join(TEST_DIR, file), readFileSync(join(JOB_FIXTURES_DIR, file)));
  }
}

const DISTILLATION_OFFSET_MIN = 3 * 60;

describe("curator pipeline job files", () => {
  it("parse as valid cron jobs (frontmatter contract)", () => {
    const jobs = jobFixtures();
    expect(jobs).toHaveLength(3);

    for (const job of jobs) {
      expect(job.enabled).toBe(false);
      expect(job.schedule).toMatch(/^\d+ \d+ \* \* [\d,]+$/);
    }
  });

  it("defines the pipeline in order: stage1 → stage2 → ping", () => {
    const [stage1, stage2, ping] = jobFixtures();
    const toMinutes = (s: string) => {
      const [m, h] = s.split(" ").map(Number) as [number, number];
      return h * 60 + m;
    };
    expect(toMinutes(stage1.schedule)).toBeLessThan(toMinutes(stage2.schedule));
    expect(toMinutes(stage2.schedule)).toBeLessThan(toMinutes(ping.schedule));
    expect(stage1.schedule.split(" ")[4]).toBe(stage2.schedule.split(" ")[4]);
    expect(stage2.schedule.split(" ")[4]).toBe(ping.schedule.split(" ")[4]);
  });

  it("runs at night, staggered after distillation-daily (03:00)", () => {
    for (const job of jobFixtures()) {
      const [m, h] = job.schedule.split(" ").map(Number) as [number, number];
      expect(h * 60 + m).toBeGreaterThan(DISTILLATION_OFFSET_MIN);
    }
  });

  it("references only existing curator profiles by name", async () => {
    copyJobFixtures();
    const result = await loadCronJobs(TEST_DIR);
    expect(result.errors).toEqual([]);

    const { profiles } = await loadAgentProfiles({ profilesDir: PROFILES_DIR });
    const names = new Set(profiles.map((p) => p.name));

    for (const job of result.jobs) {
      if (job.type === "agent") {
        expect(names.has(job.agent ?? "")).toBe(true);
      }
    }
  });

  it("references the registered script job function", () => {
    const ping = jobFixtures().find((j) => j.type === "script");
    expect(ping?.body).toBe("curator-ping");
  });
});

